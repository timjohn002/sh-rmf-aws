// The server's one MQTT connection to LiftMind: status, the recent message log, the test ride
// and request/response matching. Configured from the saved settings (see ../store.ts).

import { randomBytes, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt'
import type { ElevatorsLive, LiftMindMessage, LiftMindState, TestRide, TestRideAction } from '../../../src/types/api'
import { logJson } from '../../app'
import { HttpError } from '../../lib/http'
import {
  SERVICE_STATUS_TOPIC,
  type LiftMindIncoming,
  type OutgoingMessage,
  cancelRequest,
  decodePayload,
  elevatorRequest,
  enteredElevator,
  exitedElevator,
  parseIncoming,
  parseRobotTopic,
  parseServiceStatus,
  recoveryRequest,
  robotTopic,
  topicKindFor,
} from './messages'
import { type RideSent, allowedActions, applyRideEvent, isFinished, startRide } from './testRide'

export interface LiftMindSettings {
  enabled: boolean
  host: string
  port: number
  useTls: boolean
  /** PEM. Without it, TLS uses the system's trusted CAs. */
  caCert: string | null
  clientIdPrefix: string
  manufacturerId: string
  username: string
  password: string
  /** LiftMind robots whose response topics to subscribe to. */
  robotIds: string[]
}

const MAX_MESSAGES = 200

export function isComplete(s: LiftMindSettings): boolean {
  return !!s.host && s.port > 0 && !!s.manufacturerId
}

interface Waiter {
  titles: string[]
  resolve: (message: LiftMindIncoming) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class LiftMindLink {
  private client: MqttClient | null = null
  private settings: LiftMindSettings | null = null
  private state: LiftMindState = 'not_configured'
  private error: string | null = null
  private service: 'online' | 'offline' | null = null
  private clientId: string | null = null
  private messages: LiftMindMessage[] = []
  private nextMessageId = 1
  private ride: TestRide | null = null
  private waiters = new Map<string, Waiter>()

  constructor(private readonly connectFn: typeof mqtt.connect = mqtt.connect) {}

  /** (Re)connect with these settings. Missing, incomplete or disabled settings just disconnect. */
  async configure(settings: LiftMindSettings | null): Promise<void> {
    const wasConnected = !!this.client
    await this.disconnect()
    this.settings = settings
    this.service = null
    this.error = null
    if (!settings || !isComplete(settings) || !settings.enabled) {
      this.state = settings && isComplete(settings) ? 'disabled' : 'not_configured'
      if (wasConnected) logJson('info', 'liftmind disconnected', { reason: this.state })
      return
    }

    // Unique per process, so the laptop and the server never log each other out.
    const clientId = `${settings.clientIdPrefix}${hostname()}-${randomBytes(4).toString('hex')}`
    const options: IClientOptions = {
      clientId,
      username: settings.username || undefined,
      password: settings.password || undefined,
      keepalive: 30,
      reconnectPeriod: 5_000,
      connectTimeout: 15_000,
      clean: true,
      ...(settings.useTls ? { ca: settings.caCert ?? undefined, rejectUnauthorized: true } : {}),
    }
    this.clientId = clientId
    this.state = 'connecting'
    const client = this.connectFn(`${settings.useTls ? 'mqtts' : 'mqtt'}://${settings.host}:${settings.port}`, options)
    this.client = client
    const current = () => this.client === client

    client.on('connect', () => {
      if (!current()) return
      this.state = 'online'
      this.error = null
      logJson('info', 'liftmind connected', { client_id: clientId })
      client.subscribe(this.subscriptions(settings), { qos: 1 }, (err) => {
        if (err && current()) this.error = `Subscribing failed: ${err.message}`
      })
    })
    client.on('reconnect', () => {
      if (current() && this.state !== 'error') this.state = 'connecting'
    })
    client.on('offline', () => {
      if (current()) this.state = this.error ? 'error' : 'offline'
    })
    client.on('error', (err) => {
      if (!current()) return
      this.state = 'error'
      this.error = err.message
      logJson('error', 'liftmind connection error', { error: err.message })
    })
    client.on('message', (topic, payload) => {
      if (current()) this.receive(topic, decodePayload(payload))
    })
  }

  async disconnect(): Promise<void> {
    const client = this.client
    this.client = null
    for (const [uuid, w] of this.waiters) {
      clearTimeout(w.timer)
      w.reject(new HttpError(503, 'LiftMind connection closed'))
      this.waiters.delete(uuid)
    }
    if (!client) return
    // Graceful first, so messages just published still go out; forced after 2 s (e.g. broker gone).
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => client.end(true, {}, () => resolve()), 2_000)
      client.end(false, {}, () => {
        clearTimeout(force)
        resolve()
      })
    })
  }

  private subscriptions(s: LiftMindSettings): string[] {
    return [SERVICE_STATUS_TOPIC, ...s.robotIds.map((r) => robotTopic(s.manufacturerId, r, 'response'))]
  }

  private log(direction: 'in' | 'out', topic: string, payload: unknown): void {
    this.messages.push({ id: this.nextMessageId++, at: new Date().toISOString(), direction, topic, payload })
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES)
  }

  /** Handle a message from LiftMind (exposed for tests). */
  receive(topic: string, payload: unknown): void {
    this.log('in', topic, payload)
    if (topic === SERVICE_STATUS_TOPIC) {
      this.service = parseServiceStatus(payload) ?? this.service
      return
    }
    const parsed = parseRobotTopic(topic)
    const message = parseIncoming(payload)
    if (!parsed || parsed.kind !== 'response' || !message) return

    if (message.uuid) {
      const waiter = this.waiters.get(message.uuid)
      if (waiter && waiter.titles.includes(message.title)) {
        clearTimeout(waiter.timer)
        this.waiters.delete(message.uuid)
        waiter.resolve(message)
      }
    }
    if (this.ride && this.ride.robot === parsed.robotId) {
      this.ride = applyRideEvent(this.ride, { type: 'received', message })
    }
  }

  private publish(robotId: string, message: OutgoingMessage): void {
    const s = this.settings
    if (!this.client || !s || this.state !== 'online') {
      throw new HttpError(409, 'LiftMind is not connected. Check the connection settings on this page.')
    }
    const topic = robotTopic(s.manufacturerId, robotId, topicKindFor(message.title))
    this.client.publish(topic, JSON.stringify(message), { qos: 1 })
    this.log('out', topic, message)
  }

  /** Publish and wait for the reply with the same uuid and one of `titles`. */
  request(robotId: string, message: OutgoingMessage, titles: string[], timeoutMs = 10_000) {
    const uuid = String(message.uuid)
    return new Promise<LiftMindIncoming>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(uuid)
        reject(new HttpError(504, `LiftMind did not answer within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.waiters.set(uuid, { titles, resolve, reject, timer })
      try {
        this.publish(robotId, message)
      } catch (err) {
        clearTimeout(timer)
        this.waiters.delete(uuid)
        reject(err)
      }
    })
  }

  startTestRide(opts: {
    elevatorId: string
    elevatorName: string
    elevatorUuid: string
    robot: string
    fromFloor: string
    toFloor: string
    separated: boolean
  }): TestRide {
    if (this.ride && !isFinished(this.ride)) {
      throw new HttpError(409, 'A test ride is already running. Finish or cancel it first.')
    }
    const ride = startRide({
      uuid: randomUUID(),
      elevator_id: opts.elevatorId,
      elevator_name: opts.elevatorName,
      robot: opts.robot,
      from_floor: opts.fromFloor,
      to_floor: opts.toFloor,
    })
    this.publish(
      opts.robot,
      elevatorRequest({
        uuid: ride.uuid,
        fromFloor: opts.fromFloor,
        toFloor: opts.toFloor,
        elevatorUuid: opts.elevatorUuid,
        separated: opts.separated ? { enabled: true } : undefined,
      }),
    )
    this.ride = ride
    return ride
  }

  testRideAction(input: TestRideAction): TestRide | null {
    const ride = this.ride
    if (!ride) throw new HttpError(409, 'No test ride is running')
    if (!allowedActions(ride).has(input.action)) {
      throw new HttpError(409, `"${input.action}" isn't possible while the ride is ${ride.stage.replace('_', ' ')}`)
    }
    if (input.action === 'clear') {
      this.ride = null
      return null
    }
    let message: OutgoingMessage
    let sent: RideSent
    switch (input.action) {
      case 'entered':
        message = enteredElevator(ride.uuid, input.ok)
        sent = { title: 'ENTERED_ELEVATOR', ok: input.ok }
        break
      case 'exited':
        message = exitedElevator(ride.uuid, input.ok)
        sent = { title: 'EXITED_ELEVATOR', ok: input.ok }
        break
      case 'recover':
        message = recoveryRequest(ride.uuid, input.to_floor)
        sent = { title: 'RECOVERY_REQUEST', toFloor: input.to_floor }
        break
      case 'cancel':
        message = cancelRequest(ride.uuid)
        sent = { title: 'CANCEL_REQUEST' }
        break
    }
    this.publish(ride.robot, message)
    this.ride = applyRideEvent(ride, { type: 'sent', sent })
    return this.ride
  }

  snapshot(messageLimit = 100): ElevatorsLive {
    return {
      state: this.state,
      error: this.error,
      service: this.service,
      client_id: this.client ? this.clientId : null,
      ride: this.ride,
      messages: this.messages.slice(-messageLimit).reverse(),
    }
  }
}

/** The server's LiftMind connection. */
export const liftmind = new LiftMindLink()
