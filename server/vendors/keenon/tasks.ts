// Remote call tasks ("Send task"): which points a robot can be sent to, and the call body.
//
// Keenon spreads what a call needs over two endpoints: map/position (per floor) has each point's
// `type`, and only "normal" points are valid targets; target/list (per scene) has the `uuid` and
// `pointId` the call takes. Both carry the same point id, which joins them.

import type { KeenonTaskPoint } from '../../../src/vendors/keenon/shared'
import type { KeenonCallTaskBody, KeenonRawPoint, KeenonTarget } from './api'

export const TASK_POINT_TYPE = 'normal'

export function taskTargets(
  mapPoints: KeenonRawPoint[],
  targets: KeenonTarget[],
): { points: KeenonTaskPoint[]; unmatched: number } {
  const byId = new Map(targets.map((t) => [t.id, t]))
  const points: KeenonTaskPoint[] = []
  let unmatched = 0
  for (const p of mapPoints) {
    if ((p.type ?? '').trim().toLowerCase() !== TASK_POINT_TYPE || p.id == null) continue
    const target = byId.get(String(p.id))
    if (!target) {
      unmatched++
      continue
    }
    points.push({
      uuid: target.uuid,
      point_id: target.pointId,
      name: p.name?.trim() || target.name || `Point ${p.id}`,
      area: target.area,
    })
  }
  points.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return { points, unmatched }
}

export function callTaskBody(opts: {
  point: Pick<KeenonTaskPoint, 'uuid' | 'point_id'>
  storeId: string
  sceneCode: string
  robotSn: string
}): KeenonCallTaskBody {
  // robotType and queuingTime are optional; Keenon's defaults apply.
  return {
    uuid: opts.point.uuid,
    pointId: opts.point.point_id,
    storeId: opts.storeId,
    sceneCode: opts.sceneCode,
    robotId: opts.robotSn,
  }
}

/** The scene's target list changes rarely (Keenon suggests fetching it about daily). */
const TARGETS_TTL_MS = 10 * 60_000
const targetCache = new Map<string, { at: number; targets: KeenonTarget[] }>()

export async function cachedTargets(
  sceneCode: string,
  load: () => Promise<KeenonTarget[]>,
  { refresh = false, now = Date.now() }: { refresh?: boolean; now?: number } = {},
): Promise<KeenonTarget[]> {
  const hit = targetCache.get(sceneCode)
  if (hit && !refresh && now - hit.at < TARGETS_TTL_MS) return hit.targets
  const targets = await load()
  targetCache.set(sceneCode, { at: now, targets })
  return targets
}

/** For tests. */
export function clearTargetCache(): void {
  targetCache.clear()
}
