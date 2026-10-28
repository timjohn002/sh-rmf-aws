import { describe, expect, it } from 'vitest'
import { KEENON_CALLBACK_FIXTURES as F, type KeenonFixtureName } from './fixtures'
import { classifyKeenonCallback, computeKeenonSignature, interpretKeenonCallback, verifyKeenonSignature } from './webhook'

const NOW = new Date('2026-10-07T00:00:00Z')

describe('signature (Appendix 2)', () => {
  const body = '{"userId":"12345","action":"create"}'
  const secret = 'top-secret'
  const ts = String(NOW.getTime())

  function headers(signature: string, extra: Record<string, string> = {}) {
    return new Headers({ 'x-signature': signature, 'x-nonce': 'abc123def456', 'x-timestamp': ts, ...extra })
  }

  it('hashes body, nonce, timestamp and secret in the documented order', () => {
    // Reference value from `md5sum` of the Appendix 2 example string.
    expect(computeKeenonSignature(body, 'abc123def456', '1640995200000', 'your_secret_key')).toBe(
      'e1b64834152b68f32d52a9bdbd0717d3',
    )
  })

  it('accepts a valid signature (case-insensitive)', () => {
    const sig = computeKeenonSignature(body, 'abc123def456', ts, secret)
    expect(verifyKeenonSignature(body, headers(sig), secret, NOW.getTime()).status).toBe('valid')
    expect(verifyKeenonSignature(body, headers(sig.toUpperCase()), secret, NOW.getTime()).status).toBe('valid')
  })

  it('rejects a tampered body or wrong secret', () => {
    const sig = computeKeenonSignature(body, 'abc123def456', ts, secret)
    expect(verifyKeenonSignature(body + ' ', headers(sig), secret, NOW.getTime()).status).toBe('invalid')
    expect(verifyKeenonSignature(body, headers(sig), 'other', NOW.getTime()).status).toBe('invalid')
  })

  it('rejects a stale timestamp even when the hash matches', () => {
    const sig = computeKeenonSignature(body, 'abc123def456', ts, secret)
    const later = NOW.getTime() + 11 * 60_000
    const result = verifyKeenonSignature(body, headers(sig), secret, later)
    expect(result.status).toBe('invalid')
    expect(result.detail).toMatch(/timestamp/i)
  })

  it('reports missing headers and unconfigured secrets', () => {
    expect(verifyKeenonSignature(body, new Headers(), secret).status).toBe('missing')
    expect(verifyKeenonSignature(body, headers('x'), undefined).status).toBe('not_checked')
  })
})

describe('classification', () => {
  it.each(Object.keys(F) as KeenonFixtureName[])('recognises %s', (name) => {
    expect(classifyKeenonCallback(F[name]).type).toBe(name)
  })

  it('falls back to Unknown', () => {
    expect(classifyKeenonCallback({ hello: 'world' }).type).toBe('Unknown')
    expect(classifyKeenonCallback('nope').type).toBe('Unknown')
  })
})

describe('interpretation', () => {
  const run = (name: KeenonFixtureName) => interpretKeenonCallback(F[name], NOW)

  it('RobotOnlineStatus → offline', () => {
    expect(run('RobotOnlineStatus')).toMatchObject({
      robotExternalId: '8C:FC:A0:17:EF:C0',
      status: 'processed',
      patch: { online: false, work_state: 'offline' },
    })
  })

  it('RobotOnlineType → trimmed connection type', () => {
    expect(run('RobotOnlineType').patch).toEqual({ online_type: 'Wi-Fi' })
  })

  it('RobotPowerInfo → battery and charging', () => {
    expect(run('RobotPowerInfo').patch).toEqual({ battery: 95, charging: false })
  })

  it('RobotWorkState → idle and callable, with trimmed SN', () => {
    expect(run('RobotWorkState')).toMatchObject({
      robotExternalId: '54:EF:33:CA:E4:FF',
      patch: { work_state: 'idle', can_be_called: true },
    })
  })

  it('RobotTaskState → current task (error message only for failed tasks)', () => {
    const { patch, robotExternalId } = run('RobotTaskState')
    expect(robotExternalId).toBe('54:EF:33:CA:E4:FF')
    expect(patch?.current_task).toMatchObject({
      source: 'RobotTaskState',
      task_no: 'ZdpbzvSLehGMAZ5h',
      state: 'in_progress',
      type: 'Food delivery',
      error_code: 400,
      error_message: null,
      updated_at: NOW.toISOString(),
    })
  })

  it('RobotTaskState failure → explains the robot error', () => {
    const failed = interpretKeenonCallback({ ...F.RobotTaskState, taskState: 0, errorCode: 302 }, NOW)
    expect(failed.patch?.current_task).toMatchObject({ state: 'failed', error_message: 'The robot is busy with another task' })
  })

  it('CreateTask → robot comes from taskData', () => {
    expect(run('CreateTask')).toMatchObject({
      robotExternalId: 'demoData',
      patch: { current_task: { source: 'CreateTask', task_no: 'demoData', state: 'queued' } },
    })
  })

  it('HotelRobotBizTask → in-progress hotel delivery', () => {
    expect(run('HotelRobotBizTask')).toMatchObject({
      robotExternalId: '8C:18:D9:9D:D0:FA',
      patch: { current_task: { task_no: 'fd28f36b533141d896933d2e07930619', state: 'in_progress', type: 'Hotel delivery' } },
    })
  })

  it('HotelOrderStatus → logged, not linked to a robot', () => {
    const r = run('HotelOrderStatus')
    expect(r).toMatchObject({ status: 'ignored', robotExternalId: null, patch: null })
    expect(r.note).toContain('queued')
  })

  it('CleanRobotStatus → operating, online, hardware detail kept', () => {
    const { patch } = run('CleanRobotStatus')
    expect(patch).toMatchObject({ online: true, work_state: 'operating' })
    expect(patch?.vendor_status).toMatchObject({ kind: 'cleaning', sub_state: 21, sub_state_label: 'In operation' })
  })

  it.each([
    'RobotPositionType',
    'CleanRobotRechargeTask',
    'CleanRobotFinishTask',
    'CleanRobotPauseTask',
    'CleanStrategyTemporary',
    'AddCleanStrategy',
    'UpdateCleanStrategy',
    'DeleteCleanStrategy',
    'openAdapt',
  ] as KeenonFixtureName[])('%s → logged only', (name) => {
    expect(run(name)).toMatchObject({ eventType: name, status: 'ignored', patch: null })
  })

  it('openAdapt keeps the robot id from deviceName', () => {
    expect(run('openAdapt').robotExternalId).toBe('20:F4:1B:DD:2D:3F')
  })

  it('robot callbacks without an SN are ignored', () => {
    expect(interpretKeenonCallback({ bizType: 'RobotPowerInfo', data: { power: { batteryLevel: 5 } } })).toMatchObject({
      status: 'ignored',
      robotExternalId: null,
    })
  })
})
