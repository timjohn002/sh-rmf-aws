// State of a test ride from the Elevators page, where the user plays the robot's part.
// Pure: the connection feeds it LiftMind's messages and what the user sent.

import type { TestRide, TestRideStage } from '../../../src/types/api'
import type { LiftMindIncoming } from './messages'

export const FINISHED_STAGES: readonly TestRideStage[] = ['done', 'rejected', 'aborted', 'cancelled']

export function isFinished(ride: TestRide): boolean {
  return FINISHED_STAGES.includes(ride.stage)
}

export function startRide(
  opts: Pick<TestRide, 'uuid' | 'elevator_id' | 'elevator_name' | 'robot' | 'from_floor' | 'to_floor'>,
  now: Date = new Date(),
): TestRide {
  const at = now.toISOString()
  return {
    ...opts,
    stage: 'requested',
    assigned_elevator: null,
    reason: null,
    failed_step: null,
    recovery_floor: null,
    started_at: at,
    updated_at: at,
    history: [{ at, stage: 'requested', note: `Requested ${opts.from_floor} → ${opts.to_floor}` }],
  }
}

/** Something the user (as the robot) sent to LiftMind. */
export type RideSent =
  | { title: 'ENTERED_ELEVATOR' | 'EXITED_ELEVATOR'; ok: boolean }
  | { title: 'RECOVERY_REQUEST'; toFloor: string }
  | { title: 'CANCEL_REQUEST' }

export type RideEvent = { type: 'received'; message: LiftMindIncoming } | { type: 'sent'; sent: RideSent }

function step(ride: TestRide, now: Date, note: string, change: Partial<TestRide> = {}): TestRide {
  const next = { ...ride, ...change, updated_at: now.toISOString() }
  return { ...next, history: [...ride.history, { at: next.updated_at, stage: next.stage, note }] }
}

/** Apply one event. Events that don't belong to this ride, or arrive after it finished, change nothing. */
export function applyRideEvent(ride: TestRide, event: RideEvent, now: Date = new Date()): TestRide {
  if (isFinished(ride)) return ride
  return event.type === 'sent' ? applySent(ride, event.sent, now) : applyReceived(ride, event.message, now)
}

function applySent(ride: TestRide, sent: RideSent, now: Date): TestRide {
  switch (sent.title) {
    case 'ENTERED_ELEVATOR':
      return sent.ok
        ? step(ride, now, 'Robot entered the lift', { stage: 'entered' })
        : step(ride, now, 'Reported: robot could not enter')
    case 'EXITED_ELEVATOR':
      return sent.ok
        ? step(ride, now, 'Robot exited the lift', { stage: 'done', reason: null })
        : step(ride, now, 'Reported: robot could not exit')
    case 'RECOVERY_REQUEST':
      return step(ride, now, `Asked to recover to ${sent.toFloor}`, { stage: 'recovering', recovery_floor: sent.toFloor })
    case 'CANCEL_REQUEST':
      return step(ride, now, 'Asked to cancel the ride')
  }
}

function applyReceived(ride: TestRide, msg: LiftMindIncoming, now: Date): TestRide {
  // Replies that carry a uuid must be for this ride.
  if (msg.uuid && msg.uuid !== ride.uuid) return ride
  const reason = msg.reason ?? null

  switch (msg.title) {
    case 'ELEVATOR_RESPONSE':
      if (ride.stage !== 'requested') return ride
      return msg.is_success
        ? step(ride, now, `Lift assigned${msg.elevator_uuid ? `: ${msg.elevator_uuid}` : ''}`, {
            stage: 'dispatched',
            assigned_elevator: msg.elevator_uuid ?? null,
          })
        : step(ride, now, `Request rejected${reason ? `: ${reason}` : ''}`, { stage: 'rejected', reason })

    case 'ELEVATOR_ARRIVED': {
      const floor = msg.floor ?? '?'
      if ((ride.stage === 'requested' || ride.stage === 'dispatched') && floor === ride.from_floor) {
        return step(ride, now, `Lift arrived at ${floor}: robot may enter`, { stage: 'at_start' })
      }
      if (ride.stage === 'entered' && floor === ride.to_floor) {
        return step(ride, now, `Lift arrived at ${floor}: robot may exit`, { stage: 'at_destination' })
      }
      if (ride.stage === 'recovering' && floor === ride.recovery_floor) {
        // After a failed entry the robot tries to enter again; after a failed exit it gets out here.
        return ride.failed_step === 'exit'
          ? step(ride, now, `Lift arrived at ${floor}: robot may exit`, { stage: 'at_destination', to_floor: floor })
          : step(ride, now, `Lift arrived at ${floor}: robot may enter`, { stage: 'at_start', from_floor: floor })
      }
      return step(ride, now, `Lift arrived at ${floor}`)
    }

    case 'ENTERED_ELEVATOR_RESPONSE':
    case 'EXITED_ELEVATOR_RESPONSE':
      return msg.is_success === false
        ? step(ride, now, `LiftMind did not accept the report${reason ? `: ${reason}` : ''}`, { reason })
        : ride

    case 'PENDING_FOR_ENTER_FAILED':
    case 'PENDING_FOR_EXIT_FAILED': {
      const failed = msg.title === 'PENDING_FOR_ENTER_FAILED' ? 'enter' : 'exit'
      return step(ride, now, `Waiting for a decision: ${failed} failed${reason ? ` (${reason})` : ''}`, {
        stage: 'pending_recovery',
        failed_step: failed,
        reason,
      })
    }

    case 'RECOVERY_REQUEST_RESPONSE':
      return msg.is_success === false
        ? step(ride, now, `Recovery refused${reason ? `: ${reason}` : ''}`, { stage: 'pending_recovery', reason })
        : step(ride, now, 'Recovery accepted')

    case 'CANCEL_RESPONSE':
      return msg.is_success === false
        ? step(ride, now, `Cancel refused${reason ? `: ${reason}` : ''}`, { reason })
        : step(ride, now, 'Ride cancelled', { stage: 'cancelled' })

    case 'ABORT_REQUEST':
      return step(ride, now, `LiftMind ended the ride${reason ? `: ${reason}` : ''}`, { stage: 'aborted', reason })

    case 'ERROR_EVENT':
    case 'EXCEPTION_EVENT':
      return step(ride, now, `${msg.title === 'ERROR_EVENT' ? 'Lift error' : 'Exception'}: ${reason ?? 'unknown'}`, { reason })

    case 'ELEVATOR_EVENT':
      return step(ride, now, `Lift event: ${msg.name ?? 'unknown'}`)

    default:
      return ride
  }
}

/** What the user may send in the current stage. */
export function allowedActions(ride: TestRide | null): Set<'entered' | 'exited' | 'recover' | 'cancel' | 'clear'> {
  if (!ride) return new Set()
  if (isFinished(ride)) return new Set(['clear'])
  const actions = new Set<'entered' | 'exited' | 'recover' | 'cancel' | 'clear'>(['cancel', 'clear'])
  if (ride.stage === 'at_start') actions.add('entered')
  if (ride.stage === 'at_destination') actions.add('exited')
  if (ride.stage === 'pending_recovery') actions.add('recover')
  return actions
}
