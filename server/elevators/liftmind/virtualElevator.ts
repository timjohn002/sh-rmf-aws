// A virtual LiftMind elevator on an in-process MQTT broker (aedes), for local testing without a
// real lift: `npm run liftmind:mock` and the connection tests. Not used by the app itself.

import type { Aedes } from 'aedes'
import { SERVICE_STATUS_TOPIC, decodePayload, normalizeTitle, parseRobotTopic, robotTopic } from './messages'

interface Mission {
  uuid: string
  elevator: string
  from: string
  to: string
  /** What the robot is expected to do next. */
  waiting: 'arrival_start' | 'enter' | 'arrival_dest' | 'exit' | 'recovery'
  failed: 'enter' | 'exit' | null
}

export interface VirtualElevatorOptions {
  /** Time the lift takes to reach a floor. */
  travelMs?: number
  log?: (line: string) => void
}

type Packet = Parameters<Aedes['publish']>[0]

export function attachVirtualElevator(broker: Aedes, opts: VirtualElevatorOptions = {}): void {
  const travelMs = opts.travelMs ?? 3_000
  const log = opts.log ?? (() => {})
  const missions = new Map<string, Mission>() // by robot

  const publish = (topic: string, body: unknown, retain = false) => {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    broker.publish({ cmd: 'publish', topic, payload, qos: 0, retain, dup: false } as Packet, () => {})
  }

  publish(SERVICE_STATUS_TOPIC, 'online', true)

  broker.subscribe(
    'liftmind/+/+/v2/+',
    (packet, done) => {
      done()
      const where = parseRobotTopic(packet.topic)
      if (!where || where.kind === 'response') return
      const body = decodePayload(packet.payload as Buffer) as Record<string, unknown>
      const reply = (message: Record<string, unknown>) =>
        publish(robotTopic(where.manufacturerId, where.robotId, 'response'), message)
      const later = (fn: () => void) => setTimeout(fn, travelMs)
      const title = normalizeTitle(body?.title)
      const uuid = typeof body?.uuid === 'string' ? body.uuid : ''
      const mission = missions.get(where.robotId)
      log(`${where.robotId} → ${title}`)

      switch (title) {
        case 'ELEVATOR_REQUEST': {
          if (mission) {
            reply({ uuid, title: 'ELEVATOR_RESPONSE', is_success: false, reason: 'ALREADY_IN_TASK' })
            return
          }
          const from = String(body.from_floor ?? '')
          const to = String(body.to_floor ?? '')
          if (!from || !to) {
            reply({ uuid, title: 'ELEVATOR_RESPONSE', is_success: false, reason: 'UNKNOWN_FLOOR' })
            return
          }
          const elevator = String(body.elevator_uuid ?? 'elev_01')
          const m: Mission = { uuid, elevator, from, to, waiting: 'arrival_start', failed: null }
          missions.set(where.robotId, m)
          reply({ uuid, title: 'ELEVATOR_RESPONSE', is_success: true, reason: '', elevator_uuid: elevator })
          later(() => {
            if (missions.get(where.robotId) !== m) return
            m.waiting = 'enter'
            reply({ title: 'ELEVATOR_ARRIVED', floor: from })
          })
          return
        }

        case 'ENTERED_ELEVATOR':
        case 'EXITED_ELEVATOR': {
          const entering = title === 'ENTERED_ELEVATOR'
          const responseTitle = `${title}_RESPONSE`
          if (!mission || mission.waiting !== (entering ? 'enter' : 'exit')) {
            reply({ uuid, title: responseTitle, is_success: false, reason: mission ? 'INVALID_STATE' : 'ELEVATOR_REQUEST_NOT_FOUND' })
            return
          }
          reply({ uuid, title: responseTitle, is_success: true })
          if (body.is_success === false) {
            mission.waiting = 'recovery'
            mission.failed = entering ? 'enter' : 'exit'
            reply({ title: entering ? 'PENDING_FOR_ENTER_FAILED' : 'PENDING_FOR_EXIT_FAILED' })
          } else if (entering) {
            mission.waiting = 'arrival_dest'
            later(() => {
              if (missions.get(where.robotId) !== mission) return
              mission.waiting = 'exit'
              reply({ title: 'ELEVATOR_ARRIVED', floor: mission.to })
            })
          } else {
            missions.delete(where.robotId)
          }
          return
        }

        case 'RECOVERY_REQUEST': {
          if (!mission || mission.waiting !== 'recovery') {
            reply({ uuid, title: 'RECOVERY_REQUEST_RESPONSE', is_success: false, reason: 'INVALID_STATE' })
            return
          }
          const floor = String(body.to_floor ?? mission.from)
          reply({ uuid, title: 'RECOVERY_REQUEST_RESPONSE', is_success: true, reason: '' })
          later(() => {
            if (missions.get(where.robotId) !== mission) return
            mission.waiting = mission.failed === 'exit' ? 'exit' : 'enter'
            if (mission.failed === 'exit') mission.to = floor
            reply({ title: 'ELEVATOR_ARRIVED', floor })
          })
          return
        }

        case 'CANCEL_REQUEST':
          if (!mission) {
            reply({ uuid, title: 'CANCEL_RESPONSE', is_success: false, reason: 'ELEVATOR_REQUEST_NOT_FOUND' })
            return
          }
          missions.delete(where.robotId)
          reply({ uuid, title: 'CANCEL_RESPONSE', is_success: true, reason: '' })
          return

        case 'CHECK_REQUEST': {
          const elevator = String(body.elevator_uuid ?? body.lobby_uuid ?? 'elev_01')
          const busy = [...missions.values()].filter((m) => m.elevator === elevator).length
          reply({ uuid, title: 'CHECK_RESPONSE', is_success: true, queue_length: { [elevator]: busy } })
          return
        }

        default:
          reply({ title: 'EXCEPTION_EVENT', reason: 'UNKNOWN_TITLE' })
      }
    },
    () => {},
  )
}
