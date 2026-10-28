import { describe, expect, it, vi } from 'vitest'
import type { RobotPosition } from '../../src/types/api'
import { STALE_AFTER_MS, VENDOR_BACKOFF_MS, buildMapRobots, isStale, type MapRobotsDeps } from './mapRobots'
import type { MapPositionsCapability, MapRobotRow, VendorAdapter, VendorConfigRow } from './types'

const NOW = Date.parse('2026-10-09T08:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function robot(id: string, patch: Partial<MapRobotRow> = {}): MapRobotRow {
  return { id, vendor: 'fake', external_id: `ext-${id}`, name: `Robot ${id}`, model: null, online: true, position: null, ...patch }
}

function pos(fetchedMsAgo: number | null, x = 1): RobotPosition {
  return {
    floor: '1',
    x,
    y: 2,
    heading_rad: null,
    reported_at: null,
    source: 'fake',
    fetched_at: fetchedMsAgo === null ? null : iso(fetchedMsAgo),
  }
}

function setup(robots: MapRobotRow[], locate?: MapPositionsCapability['locate']) {
  const capability: MapPositionsCapability = {
    refreshAfterMs: 4_000,
    prepare: vi.fn(async () => ({
      isLocatable: (r: MapRobotRow) => r.online !== false,
      place: (r: MapRobotRow) =>
        r.position
          ? { floor_id: 'floor-1', x_px: r.position.x * 10, y_px: r.position.y * 10, heading_rad: null }
          : { reason: 'no position yet' },
    })),
    locate: vi.fn(
      locate ?? (async (_ctx, rs: MapRobotRow[]) => new Map(rs.map((r) => [r.id, pos(null, 9)]))),
    ),
  }
  const adapter = { id: 'fake', name: 'Fake', isConfigured: () => true, mapPositions: capability } as unknown as VendorAdapter
  const saved: Record<string, RobotPosition> = {}
  const deps: MapRobotsDeps = {
    adapters: [adapter],
    loadRobots: async () => robots.map((r) => ({ ...r })),
    loadConfig: async () => ({ vendor: 'fake' }) as VendorConfigRow,
    contextFor: () => ({}) as never,
    savePosition: async (id, p) => {
      saved[id] = p
    },
    now: () => NOW,
    backoff: new Map(),
  }
  return { deps, capability, saved }
}

describe('buildMapRobots', () => {
  it('only asks the vendor about positions older than its refresh interval', async () => {
    const { deps, capability, saved } = setup([robot('fresh', { position: pos(1_000) }), robot('old', { position: pos(10_000) })])
    const res = await buildMapRobots(deps)
    expect(capability.locate).toHaveBeenCalledTimes(1)
    expect(vi.mocked(capability.locate).mock.calls[0][1].map((r) => r.id)).toEqual(['old'])
    expect(saved.old).toMatchObject({ x: 9, fetched_at: new Date(NOW).toISOString() })
    expect(res.robots.find((r) => r.id === 'old')).toMatchObject({ x_px: 90, stale: false })
    expect(res.robots.find((r) => r.id === 'fresh')).toMatchObject({ x_px: 10, stale: false })
  })

  it('does not call the vendor when every position is fresh', async () => {
    const { deps, capability } = setup([robot('a', { position: pos(500) })])
    await buildMapRobots(deps)
    expect(capability.locate).not.toHaveBeenCalled()
  })

  it('backs off a vendor that cannot be reached and keeps the last positions', async () => {
    const { deps, capability } = setup([robot('a', { position: pos(10 * 60_000) })], async () => {
      throw new Error('IP not whitelisted')
    })
    const first = await buildMapRobots(deps)
    expect(first.warnings[0]).toMatch(/Couldn't get robot positions from Fake: IP not whitelisted/)
    expect(first.robots[0]).toMatchObject({ id: 'a', stale: true })

    const second = await buildMapRobots(deps)
    expect(capability.locate).toHaveBeenCalledTimes(1)
    expect(second.warnings).toEqual(first.warnings)

    deps.now = () => NOW + VENDOR_BACKOFF_MS + 1
    await buildMapRobots(deps)
    expect(capability.locate).toHaveBeenCalledTimes(2)
  })

  it('lists robots that cannot be placed, including vendors without map support', async () => {
    const { deps } = setup([robot('a'), robot('b', { vendor: 'other' })])
    deps.adapters = [...deps.adapters, { id: 'other', name: 'Other' } as VendorAdapter]
    deps.loadConfig = async (v) => (v === 'fake' ? ({ vendor: 'fake' } as VendorConfigRow) : null)
    // Robot "a" gets located (no position yet), so it is placed; "b" can't be.
    const res = await buildMapRobots(deps)
    expect(res.robots.map((r) => r.id)).toEqual(['a'])
    expect(res.not_shown).toEqual([
      { id: 'b', vendor: 'other', vendor_name: 'Other', name: 'Robot b', reason: "Other robots can't be shown on the map yet" },
    ])
  })
})

describe('isStale', () => {
  it('is stale when offline, never located, or not refreshed for a while', () => {
    expect(isStale(robot('a', { position: pos(1_000) }), NOW)).toBe(false)
    expect(isStale(robot('a', { position: pos(1_000), online: false }), NOW)).toBe(true)
    expect(isStale(robot('a', { position: pos(null) }), NOW)).toBe(true)
    expect(isStale(robot('a', { position: pos(STALE_AFTER_MS + 1) }), NOW)).toBe(true)
  })
})
