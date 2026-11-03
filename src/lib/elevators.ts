import type { BadgeTone } from '../components/ui'
import type { LiftMindState, TestRide, TestRideStage } from '../types/api'

/** LiftMind's usual name for a floor level: 1 → 1F, -1 → B1F, 0 → G. Only a suggestion; sites can differ. */
export function suggestLiftMindFloor(level: number): string {
  if (level > 0) return `${level}F`
  if (level < 0) return `B${-level}F`
  return 'G'
}

export const CONNECTION_STATE: Record<LiftMindState, { label: string; tone: BadgeTone }> = {
  not_configured: { label: 'Not configured', tone: 'slate' },
  disabled: { label: 'Disabled', tone: 'amber' },
  connecting: { label: 'Connecting…', tone: 'blue' },
  online: { label: 'Connected', tone: 'green' },
  offline: { label: 'Offline', tone: 'red' },
  error: { label: 'Error', tone: 'red' },
}

/** The normal ride, in order. */
export const RIDE_STEPS: { stage: TestRideStage; label: string }[] = [
  { stage: 'requested', label: 'Requested' },
  { stage: 'dispatched', label: 'Lift assigned' },
  { stage: 'at_start', label: 'At start floor' },
  { stage: 'entered', label: 'Robot in lift' },
  { stage: 'at_destination', label: 'At destination' },
  { stage: 'done', label: 'Done' },
]

export const RIDE_SIDE_STATE: Partial<Record<TestRideStage, { label: string; tone: BadgeTone }>> = {
  pending_recovery: { label: 'Waiting for a decision', tone: 'amber' },
  recovering: { label: 'Recovering', tone: 'amber' },
  rejected: { label: 'Rejected', tone: 'red' },
  aborted: { label: 'Aborted by LiftMind', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
}

export function rideFinished(ride: TestRide | null): boolean {
  return !!ride && ['done', 'rejected', 'aborted', 'cancelled'].includes(ride.stage)
}
