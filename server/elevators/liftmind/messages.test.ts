import { describe, expect, it } from 'vitest'
import {
  checkRequest,
  decodePayload,
  elevatorRequest,
  normalizeTitle,
  parseIncoming,
  parseRobotTopic,
  parseServiceStatus,
  robotTopic,
  topicKindFor,
} from './messages'

describe('topics', () => {
  it('builds and parses robot topics', () => {
    const topic = robotTopic('m-1', 'rb-7', 'response')
    expect(topic).toBe('liftmind/m-1/rb-7/v2/response')
    expect(parseRobotTopic(topic)).toEqual({ manufacturerId: 'm-1', robotId: 'rb-7', kind: 'response' })
    expect(parseRobotTopic('liftmind/service/robot/status')).toBeNull()
  })

  it('sends status reports to …/status and everything else to …/request', () => {
    expect(topicKindFor('ENTERED_ELEVATOR')).toBe('status')
    expect(topicKindFor('EXITED_ELEVATOR')).toBe('status')
    expect(topicKindFor('ELEVATOR_REQUEST')).toBe('request')
    expect(topicKindFor('CHECK_REQUEST')).toBe('request')
  })
})

describe('titles', () => {
  it.each([
    ['ELEVATOR_REQUEST_RESPONSE', 'ELEVATOR_RESPONSE'],
    ['CANCEL_MISSION', 'CANCEL_REQUEST'],
    ['CANCEL_MISSION_RESPONSE', 'CANCEL_RESPONSE'],
    ['ABORT_MISSION', 'ABORT_REQUEST'],
    ['ELEVATOR_ARRIVED', 'ELEVATOR_ARRIVED'],
    [' elevator_response ', 'ELEVATOR_RESPONSE'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected)
  })
})

describe('incoming messages', () => {
  it('keeps the known fields and normalizes the title', () => {
    expect(
      parseIncoming({ uuid: 'u1', title: 'ELEVATOR_REQUEST_RESPONSE', is_success: true, reason: '', elevator_uuid: 'elev_01' }),
    ).toEqual({ title: 'ELEVATOR_RESPONSE', uuid: 'u1', is_success: true, reason: undefined, floor: undefined, elevator_uuid: 'elev_01', name: undefined, queue_length: undefined })
  })

  it('ignores payloads without a title', () => {
    expect(parseIncoming({ floor: '3F' })).toBeNull()
    expect(parseIncoming('online')).toBeNull()
  })

  it('reads the service status as text or JSON', () => {
    expect(parseServiceStatus('online')).toBe('online')
    expect(parseServiceStatus('"offline"')).toBe('offline')
    expect(parseServiceStatus({ status: 'online' })).toBe('online')
    expect(parseServiceStatus('maybe')).toBeNull()
  })

  it('decodes JSON payloads and leaves text alone', () => {
    expect(decodePayload(Buffer.from('{"a":1}'))).toEqual({ a: 1 })
    expect(decodePayload(Buffer.from('online'))).toBe('online')
  })
})

describe('outgoing messages', () => {
  it('ELEVATOR_REQUEST targets the elevator, not the lobby, when both are known', () => {
    expect(
      elevatorRequest({ uuid: 'u1', fromFloor: '1F', toFloor: '5F', elevatorUuid: 'lc-1', lobbyUuid: 'lobby_01', separated: { enabled: true } }),
    ).toEqual({
      uuid: 'u1',
      title: 'ELEVATOR_REQUEST',
      from_floor: '1F',
      to_floor: '5F',
      elevator_uuid: 'lc-1',
      separated_mode_options: { enabled: true },
    })
  })

  it('ELEVATOR_REQUEST falls back to the lobby', () => {
    expect(elevatorRequest({ uuid: 'u1', fromFloor: '1F', toFloor: '2F', lobbyUuid: 'lobby_01' })).toMatchObject({
      lobby_uuid: 'lobby_01',
    })
  })

  it('CHECK_REQUEST asks about one elevator', () => {
    expect(checkRequest('u2', { elevatorUuid: 'lc-1' })).toEqual({ uuid: 'u2', title: 'CHECK_REQUEST', elevator_uuid: 'lc-1' })
  })
})
