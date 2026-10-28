// Robots on the Map page, for every vendor that supports it (`VendorAdapter.mapPositions`):
// refresh positions that are out of date, then place each robot on an app floor.

import type { MapRobotNotShown, MapRobotsResponse, RobotPosition } from '../../src/types/api'
import type { MapPlacer, MapRobotRow, VendorAdapter, VendorConfigRow, VendorContext } from './types'

/** No fresh position for this long (or offline): drawn faded. */
export const STALE_AFTER_MS = 2 * 60_000
/** After a vendor can't be reached, don't ask it again for this long. */
export const VENDOR_BACKOFF_MS = 60_000

export interface MapRobotsDeps {
  adapters: readonly VendorAdapter[]
  loadRobots(): Promise<MapRobotRow[]>
  loadConfig(vendor: string): Promise<VendorConfigRow | null>
  contextFor(config: VendorConfigRow): VendorContext
  savePosition(robotId: string, position: RobotPosition): Promise<void>
  now(): number
  /** Vendors not to ask until `until` (kept across calls by the caller). */
  backoff: Map<string, { until: number; message: string }>
}

function fetchedAt(robot: MapRobotRow): number {
  return robot.position?.fetched_at ? Date.parse(robot.position.fetched_at) : 0
}

export function isStale(robot: MapRobotRow, now: number): boolean {
  return robot.online === false || now - fetchedAt(robot) > STALE_AFTER_MS
}

export async function buildMapRobots(deps: MapRobotsDeps): Promise<MapRobotsResponse> {
  const mapped = deps.adapters.filter((a) => a.mapPositions)
  // Independent reads, in parallel: every round trip to the database adds up at a 5 s refresh.
  const [all, configs] = await Promise.all([
    deps.loadRobots(),
    Promise.all(mapped.map((a) => deps.loadConfig(a.id))),
  ])
  const out: MapRobotsResponse = { robots: [], not_shown: [], warnings: [] }

  const perVendor = await Promise.all(
    mapped.map(async (adapter, i) => {
      const robots = all.filter((r) => r.vendor === adapter.id)
      if (!robots.length) return null
      const placer = await adapter.mapPositions!.prepare(robots)
      const warning = await refreshPositions(deps, adapter, configs[i], placer, robots)
      return { adapter, robots, placer, warning }
    }),
  )

  for (const vendor of perVendor) {
    if (!vendor) continue
    const { adapter, robots, placer, warning } = vendor
    if (warning) out.warnings.push(warning)
    for (const robot of robots) {
      const placement = placer.place(robot)
      if ('reason' in placement) {
        out.not_shown.push(notShown(robot, adapter.name, placement.reason))
        continue
      }
      out.robots.push({
        id: robot.id,
        vendor: robot.vendor,
        vendor_name: adapter.name,
        name: robot.name,
        model: robot.model,
        floor_id: placement.floor_id,
        x_px: placement.x_px,
        y_px: placement.y_px,
        heading_rad: placement.heading_rad,
        position_at: robot.position?.fetched_at ?? null,
        stale: isStale(robot, deps.now()),
      })
    }
  }

  for (const robot of all) {
    if (mapped.some((a) => a.id === robot.vendor)) continue
    const name = deps.adapters.find((a) => a.id === robot.vendor)?.name ?? robot.vendor
    out.not_shown.push(notShown(robot, name, `${name} robots can't be shown on the map yet`))
  }
  return out
}

function notShown(robot: MapRobotRow, vendorName: string, reason: string): MapRobotNotShown {
  return { id: robot.id, vendor: robot.vendor, vendor_name: vendorName, name: robot.name, reason }
}

/**
 * Ask the vendor for positions older than its refresh interval. Updates `robots` in place.
 * Returns a warning when the vendor couldn't be asked.
 */
async function refreshPositions(
  deps: MapRobotsDeps,
  adapter: VendorAdapter,
  config: VendorConfigRow | null,
  placer: MapPlacer,
  robots: MapRobotRow[],
): Promise<string | null> {
  const capability = adapter.mapPositions!
  const now = deps.now()
  const backoff = deps.backoff.get(adapter.id)
  if (backoff && backoff.until > now) return backoff.message
  if (!config || !adapter.isConfigured(config)) return null

  const due = robots.filter((r) => placer.isLocatable(r) && now - fetchedAt(r) >= capability.refreshAfterMs)
  if (!due.length) return null

  let positions: Map<string, RobotPosition>
  try {
    positions = await capability.locate(deps.contextFor(config), due)
  } catch (err) {
    const message = `Couldn't get robot positions from ${adapter.name}: ${err instanceof Error ? err.message : String(err)}`
    deps.backoff.set(adapter.id, { until: now + VENDOR_BACKOFF_MS, message })
    console.warn(message)
    return message
  }
  deps.backoff.delete(adapter.id)

  const fetched_at = new Date(now).toISOString()
  const updated = robots.filter((r) => positions.has(r.id))
  for (const robot of updated) robot.position = { ...positions.get(robot.id)!, fetched_at }
  await Promise.all(updated.map((r) => deps.savePosition(r.id, r.position!)))
  return null
}
