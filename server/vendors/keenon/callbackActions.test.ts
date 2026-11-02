import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VendorConfigRow } from '../types'
import { type ElevatorStepHandler, elevatorStep, handleKeenonCallback } from './callbackActions'
import { KEENON_CALLBACK_FIXTURES as F } from './fixtures'

const config = { vendor: 'keenon' } as VendorConfigRow

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('elevatorStep', () => {
  it('reads the openAdapt fields', () => {
    expect(elevatorStep(F.openAdapt)).toEqual({
      action: 'QueryElevatorGroup',
      taskNo: '1237412342',
      messageId: 1569812313003,
      robotSn: '20:F4:1B:DD:2D:3F',
      data: { dstId: 2, sourceFloorNum: 1, targetFloorNum: 11 },
    })
  })

  it('is null without an action', () => {
    expect(elevatorStep({ bizType: 'openAdapt', data: { deviceName: 'R1' } })).toBeNull()
  })
})

describe('handleKeenonCallback', () => {
  const event = { eventType: 'openAdapt/QueryElevatorGroup', robotExternalId: '20:F4:1B:DD:2D:3F', body: F.openAdapt }

  it('runs the handler for the elevator step', async () => {
    const query = vi.fn<ElevatorStepHandler>(async () => {})
    const other = vi.fn<ElevatorStepHandler>(async () => {})
    await handleKeenonCallback(event, config, { QueryElevatorGroup: query, TerminateTask: other })
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ action: 'QueryElevatorGroup', taskNo: '1237412342' }), config)
    expect(other).not.toHaveBeenCalled()
  })

  it('ignores an elevator action without a handler', async () => {
    await expect(handleKeenonCallback(event, config, {})).resolves.toBeUndefined()
  })

  it('ignores non-elevator callbacks', async () => {
    const query = vi.fn<ElevatorStepHandler>(async () => {})
    await handleKeenonCallback({ ...event, eventType: 'RobotWorkState' }, config, { QueryElevatorGroup: query })
    expect(query).not.toHaveBeenCalled()
  })

  it('logs every documented step by default', async () => {
    await handleKeenonCallback(event, config)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('elevator step received'))
  })
})
