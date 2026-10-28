import { describe, expect, it } from 'vitest'
import type { Robot, RobotVendorInfo } from '../../src/types/api'
import { groupRobots, unknownVendorInfo } from './robotGroups'

function robot(vendor: string, external_id: string, name: string | null = null): Robot {
  return {
    id: `${vendor}-${external_id}`,
    vendor,
    external_id,
    name,
    store_external_id: null,
    store_name: null,
    model: null,
    app_version: null,
    online: null,
    online_type: null,
    battery: null,
    charging: null,
    work_state: 'unknown',
    can_be_called: null,
    current_task: null,
    vendor_status: null,
    position: null,
    last_seen_at: null,
    last_refreshed_at: null,
    updated_at: '2026-10-07T00:00:00Z',
  }
}

const KNOWN: Record<string, string> = { keenon: 'Keenon', pudu: 'Pudu' }
const info = (id: string): RobotVendorInfo =>
  KNOWN[id]
    ? { id, name: KNOWN[id], status: 'connected', capabilities: { refresh: true, refresh_cooldown_ms: 10_000 }, last_refreshed_at: null }
    : unknownVendorInfo(id)

describe('groupRobots', () => {
  it('returns no groups for no robots', () => {
    expect(groupRobots([], info)).toEqual([])
  })

  it('groups by vendor, sorted by vendor name then robot name (numeric-aware)', () => {
    const groups = groupRobots(
      [robot('pudu', 'P1', 'Bella'), robot('keenon', 'K3', 'C40'), robot('keenon', 'K1', 'C30'), robot('keenon', 'K2', 'C100')],
      info,
    )
    expect(groups.map((g) => g.vendor.name)).toEqual(['Keenon', 'Pudu'])
    expect(groups[0].robots.map((r) => r.name)).toEqual(['C30', 'C40', 'C100'])
  })

  it('falls back to the serial number for unnamed robots', () => {
    const [group] = groupRobots([robot('keenon', 'ZZ', 'Alpha'), robot('keenon', 'AA:BB')], info)
    expect(group.robots.map((r) => r.external_id)).toEqual(['AA:BB', 'ZZ'])
  })

  it("reports each vendor's most recent refresh", () => {
    const a = { ...robot('keenon', 'K1'), last_refreshed_at: '2026-10-07T07:00:00Z' }
    const b = { ...robot('keenon', 'K2'), last_refreshed_at: '2026-10-07T08:00:00Z' }
    const [keenon, pudu] = groupRobots([a, b, robot('pudu', 'P1')], info)
    expect(keenon.vendor.last_refreshed_at).toBe('2026-10-07T08:00:00Z')
    expect(pudu.vendor.last_refreshed_at).toBeNull()
  })

  it('keeps robots of unknown vendors in their own group without refresh', () => {
    const groups = groupRobots([robot('acme', 'X1'), robot('keenon', 'K1')], info)
    const acme = groups.find((g) => g.vendor.id === 'acme')!
    expect(acme.vendor).toMatchObject({ name: 'acme', capabilities: { refresh: false } })
    expect(acme.robots).toHaveLength(1)
  })
})
