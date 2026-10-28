import type { Robot, RobotGroup, RobotVendorInfo } from '../../src/types/api'

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Group robots by vendor for the Robots page. Groups are sorted by vendor name,
 * robots by name (falling back to their vendor id/SN). Pure: no I/O.
 */
export function groupRobots(robots: Robot[], vendorInfo: (vendorId: string) => RobotVendorInfo): RobotGroup[] {
  const groups = new Map<string, RobotGroup>()
  for (const robot of robots) {
    let group = groups.get(robot.vendor)
    if (!group) {
      group = { vendor: vendorInfo(robot.vendor), robots: [] }
      groups.set(robot.vendor, group)
    }
    group.robots.push(robot)
  }
  const label = (r: Robot) => r.name ?? r.external_id
  return [...groups.values()]
    .map((g) => ({
      vendor: { ...g.vendor, last_refreshed_at: latest(g.robots.map((r) => r.last_refreshed_at)) },
      robots: [...g.robots].sort((a, b) => byName.compare(label(a), label(b))),
    }))
    .sort((a, b) => byName.compare(a.vendor.name, b.vendor.name))
}

/** Latest ISO timestamp, or null. */
function latest(times: (string | null)[]): string | null {
  let best: string | null = null
  for (const t of times) if (t && (!best || Date.parse(t) > Date.parse(best))) best = t
  return best
}

/** Vendor info for a robot whose vendor isn't in the code registry (e.g. a removed integration). */
export function unknownVendorInfo(vendorId: string): RobotVendorInfo {
  return {
    id: vendorId,
    name: vendorId,
    status: 'not_configured',
    capabilities: { refresh: false, refresh_cooldown_ms: 0 },
    last_refreshed_at: null,
  }
}
