import type { WorkState } from '../../src/types/api'
import type { RobotPatch } from './types'

/**
 * Work state to store alongside an update. Pure.
 *  - an explicit work state from the vendor wins (work-state / cleaning callbacks);
 *  - reported offline → 'offline';
 *  - reported online while stored as 'offline' → 'unknown' until the vendor says what it's doing;
 *  - otherwise unchanged (undefined).
 */
export function resolveWorkState(previous: WorkState | undefined, patch: RobotPatch): WorkState | undefined {
  if (patch.work_state) return patch.work_state
  if (patch.online === false) return 'offline'
  if (patch.online === true && previous === 'offline') return 'unknown'
  return undefined
}
