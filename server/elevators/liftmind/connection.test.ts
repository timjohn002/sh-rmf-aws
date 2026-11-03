// End to end over a real MQTT connection: the app's LiftMind client against the virtual elevator
// on an in-process broker.

import { type AddressInfo, type Server, createServer } from 'node:net'
import { Aedes } from 'aedes'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LiftMindSettings, LiftMindLink } from './connection'
import { checkRequest } from './messages'
import { attachVirtualElevator } from './virtualElevator'

let broker: Aedes
let server: Server
let settings: LiftMindSettings

beforeAll(async () => {
  broker = await Aedes.createBroker()
  attachVirtualElevator(broker, { travelMs: 30 })
  server = createServer(broker.handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  settings = {
    enabled: true,
    host: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    useTls: false,
    caCert: null,
    clientIdPrefix: 'test-',
    manufacturerId: 'm-1',
    username: '',
    password: '',
    robotIds: ['rb-1'],
  }
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => broker.close(() => resolve()))
})

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

async function connected(): Promise<LiftMindLink> {
  const link = new LiftMindLink()
  await link.configure(settings)
  await vi.waitFor(() => expect(link.snapshot().state).toBe('online'), { timeout: 3000 })
  await vi.waitFor(() => expect(link.snapshot().service).toBe('online'), { timeout: 3000 })
  return link
}

describe('LiftMind connection', () => {
  it('stays unconfigured without a host or manufacturer ID', async () => {
    const link = new LiftMindLink()
    await link.configure({ ...settings, host: '' })
    expect(link.snapshot().state).toBe('not_configured')
    await link.configure({ ...settings, enabled: false })
    expect(link.snapshot().state).toBe('disabled')
  })

  it('answers CHECK_REQUEST through the matching uuid', async () => {
    const link = await connected()
    const reply = await link.request('rb-1', checkRequest('check-1', { elevatorUuid: 'lc-1' }), ['CHECK_RESPONSE'])
    expect(reply).toMatchObject({ title: 'CHECK_RESPONSE', is_success: true, queue_length: { 'lc-1': 0 } })
    await link.disconnect()
  })

  it('runs a whole test ride', async () => {
    const link = await connected()
    link.startTestRide({
      elevatorId: 'e1',
      elevatorName: 'Lift A',
      elevatorUuid: 'lc-1',
      robot: 'rb-1',
      fromFloor: '1F',
      toFloor: '3F',
      separated: false,
    })
    await vi.waitFor(() => expect(link.snapshot().ride?.stage).toBe('at_start'), { timeout: 3000 })
    expect(link.snapshot().ride?.assigned_elevator).toBe('lc-1')

    link.testRideAction({ action: 'entered', ok: true })
    await vi.waitFor(() => expect(link.snapshot().ride?.stage).toBe('at_destination'), { timeout: 3000 })

    link.testRideAction({ action: 'exited', ok: true })
    expect(link.snapshot().ride?.stage).toBe('done')

    // Every message in and out is in the log, newest first.
    const titles = link
      .snapshot()
      .messages.map((m) => `${m.direction}:${(m.payload as { title?: string }).title ?? m.payload}`)
      .reverse()
    expect(titles).toEqual(
      expect.arrayContaining([
        'out:ELEVATOR_REQUEST',
        'in:ELEVATOR_RESPONSE',
        'in:ELEVATOR_ARRIVED',
        'out:ENTERED_ELEVATOR',
        'out:EXITED_ELEVATOR',
      ]),
    )
    link.testRideAction({ action: 'clear' })
    expect(link.snapshot().ride).toBeNull()
    await link.disconnect()
  })

  it('refuses a second ride and actions that do not fit the stage', async () => {
    const link = await connected()
    link.startTestRide({ elevatorId: 'e1', elevatorName: 'Lift A', elevatorUuid: 'lc-1', robot: 'rb-1', fromFloor: '1F', toFloor: '2F', separated: false })
    expect(() =>
      link.startTestRide({ elevatorId: 'e1', elevatorName: 'Lift A', elevatorUuid: 'lc-1', robot: 'rb-1', fromFloor: '1F', toFloor: '2F', separated: false }),
    ).toThrow(/already running/)
    expect(() => link.testRideAction({ action: 'exited', ok: true })).toThrow(/isn't possible/)

    link.testRideAction({ action: 'cancel' })
    await vi.waitFor(() => expect(link.snapshot().ride?.stage).toBe('cancelled'), { timeout: 3000 })
    await link.disconnect()
  })

  it('refuses to send while not connected', async () => {
    const link = new LiftMindLink()
    expect(() =>
      link.startTestRide({ elevatorId: 'e1', elevatorName: 'Lift A', elevatorUuid: 'lc-1', robot: 'rb-1', fromFloor: '1F', toFloor: '2F', separated: false }),
    ).toThrow(/not connected/)
  })
})
