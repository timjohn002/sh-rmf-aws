import { describe, expect, it } from 'vitest'
import { resolveWorkState } from './robotState'

describe('resolveWorkState', () => {
  it('keeps an explicit work state from the vendor', () => {
    expect(resolveWorkState('offline', { online: true, work_state: 'busy' })).toBe('busy')
  })

  it('marks robots reported offline as Offline', () => {
    expect(resolveWorkState('idle', { online: false })).toBe('offline')
  })

  it('clears a stale Offline badge when the robot is reported online', () => {
    expect(resolveWorkState('offline', { online: true })).toBe('unknown')
  })

  it('leaves the work state alone otherwise', () => {
    expect(resolveWorkState('charging', { online: true })).toBeUndefined()
    expect(resolveWorkState(undefined, { online: true })).toBeUndefined()
    expect(resolveWorkState('idle', { battery: 50 })).toBeUndefined()
  })
})
