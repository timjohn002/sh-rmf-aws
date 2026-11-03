import { describe, expect, it } from 'vitest'
import type { TestRide } from '../../../src/types/api'
import type { LiftMindIncoming } from './messages'
import { type RideEvent, allowedActions, applyRideEvent, startRide } from './testRide'

const start = () =>
  startRide({ uuid: 'ride-1', elevator_id: 'e1', elevator_name: 'Lift A', robot: 'rb-1', from_floor: '1F', to_floor: '5F' })

const got = (message: LiftMindIncoming): RideEvent => ({ type: 'received', message })

function run(ride: TestRide, ...events: RideEvent[]): TestRide {
  return events.reduce((r, e) => applyRideEvent(r, e), ride)
}

describe('test ride', () => {
  it('goes through the normal D Mode flow', () => {
    let ride = run(start(), got({ title: 'ELEVATOR_RESPONSE', uuid: 'ride-1', is_success: true, elevator_uuid: 'lc-1' }))
    expect(ride).toMatchObject({ stage: 'dispatched', assigned_elevator: 'lc-1' })

    ride = run(ride, got({ title: 'ELEVATOR_ARRIVED', floor: '1F' }))
    expect(ride.stage).toBe('at_start')
    expect(allowedActions(ride).has('entered')).toBe(true)

    ride = run(ride, { type: 'sent', sent: { title: 'ENTERED_ELEVATOR', ok: true } })
    expect(ride.stage).toBe('entered')

    // Stops at other floors don't move the ride on.
    ride = run(ride, got({ title: 'ELEVATOR_ARRIVED', floor: '3F' }))
    expect(ride.stage).toBe('entered')

    ride = run(ride, got({ title: 'ELEVATOR_ARRIVED', floor: '5F' }), { type: 'sent', sent: { title: 'EXITED_ELEVATOR', ok: true } })
    expect(ride.stage).toBe('done')
    expect(allowedActions(ride)).toEqual(new Set(['clear']))
    expect(ride.history.map((h) => h.stage)).toEqual(['requested', 'dispatched', 'at_start', 'entered', 'entered', 'at_destination', 'done'])
  })

  it('accepts the arrival even before the dispatch response', () => {
    expect(run(start(), got({ title: 'ELEVATOR_ARRIVED', floor: '1F' })).stage).toBe('at_start')
  })

  it('ignores replies for another request', () => {
    const ride = run(start(), got({ title: 'ELEVATOR_RESPONSE', uuid: 'other', is_success: true }))
    expect(ride.stage).toBe('requested')
  })

  it('ends when the request is rejected', () => {
    const ride = run(start(), got({ title: 'ELEVATOR_RESPONSE', uuid: 'ride-1', is_success: false, reason: 'ALREADY_IN_TASK' }))
    expect(ride).toMatchObject({ stage: 'rejected', reason: 'ALREADY_IN_TASK' })
  })

  it('ends when LiftMind aborts, and ignores anything after', () => {
    const ride = run(
      start(),
      got({ title: 'ABORT_REQUEST', reason: 'ELEVATOR_NOT_ARRIVE_IN_TIME' }),
      got({ title: 'ELEVATOR_ARRIVED', floor: '1F' }),
    )
    expect(ride).toMatchObject({ stage: 'aborted', reason: 'ELEVATOR_NOT_ARRIVE_IN_TIME' })
  })

  it('recovers after a failed entry and lets the robot enter again', () => {
    let ride = run(
      start(),
      got({ title: 'ELEVATOR_ARRIVED', floor: '1F' }),
      { type: 'sent', sent: { title: 'ENTERED_ELEVATOR', ok: false } },
      got({ title: 'PENDING_FOR_ENTER_FAILED', reason: 'ENTER_TIMEOUT' }),
    )
    expect(ride).toMatchObject({ stage: 'pending_recovery', failed_step: 'enter', reason: 'ENTER_TIMEOUT' })
    expect(allowedActions(ride).has('recover')).toBe(true)

    ride = run(
      ride,
      { type: 'sent', sent: { title: 'RECOVERY_REQUEST', toFloor: '2F' } },
      got({ title: 'RECOVERY_REQUEST_RESPONSE', uuid: 'ride-1', is_success: true }),
      got({ title: 'ELEVATOR_ARRIVED', floor: '2F' }),
    )
    expect(ride).toMatchObject({ stage: 'at_start', from_floor: '2F' })
  })

  it('after a failed exit, recovery ends at the recovery floor', () => {
    const ride = run(
      start(),
      got({ title: 'ELEVATOR_ARRIVED', floor: '1F' }),
      { type: 'sent', sent: { title: 'ENTERED_ELEVATOR', ok: true } },
      got({ title: 'ELEVATOR_ARRIVED', floor: '5F' }),
      { type: 'sent', sent: { title: 'EXITED_ELEVATOR', ok: false } },
      got({ title: 'PENDING_FOR_EXIT_FAILED' }),
      { type: 'sent', sent: { title: 'RECOVERY_REQUEST', toFloor: '1F' } },
      got({ title: 'ELEVATOR_ARRIVED', floor: '1F' }),
    )
    expect(ride).toMatchObject({ stage: 'at_destination', to_floor: '1F' })
  })

  it('a refused recovery goes back to waiting for a decision', () => {
    const ride = run(
      start(),
      got({ title: 'PENDING_FOR_ENTER_FAILED' }),
      { type: 'sent', sent: { title: 'RECOVERY_REQUEST', toFloor: '1F' } },
      got({ title: 'RECOVERY_REQUEST_RESPONSE', uuid: 'ride-1', is_success: false, reason: 'INVALID_STATE' }),
    )
    expect(ride).toMatchObject({ stage: 'pending_recovery', reason: 'INVALID_STATE' })
  })

  it('cancels once LiftMind confirms', () => {
    let ride = run(start(), { type: 'sent', sent: { title: 'CANCEL_REQUEST' } })
    expect(ride.stage).toBe('requested')
    ride = run(ride, got({ title: 'CANCEL_RESPONSE', uuid: 'ride-1', is_success: true }))
    expect(ride.stage).toBe('cancelled')
  })

  it('notes lift errors and events without changing the stage', () => {
    const ride = run(start(), got({ title: 'ERROR_EVENT', reason: 'ELEVATOR_FAULT' }), got({ title: 'ELEVATOR_EVENT', name: 'ELEVATOR_NOT_EMPTY' }))
    expect(ride.stage).toBe('requested')
    expect(ride.history.at(-1)?.note).toContain('ELEVATOR_NOT_EMPTY')
    expect(ride.reason).toBe('ELEVATOR_FAULT')
  })
})
