// Remote call tasks ("Send task"): which points a robot can be sent to, and the call body.
//
// Keenon spreads what a call needs over two endpoints: map/position (per floor) has each point's
// `type`, and only "normal" points are valid targets; target/list (per scene) has the `uuid` and
// `pointId` the call takes. Both carry the same point id, which joins them.

import type { RobotTask } from '../../../src/types/api'
import { FINISHED_TASK_STATES, type KeenonTaskPoint } from '../../../src/vendors/keenon/shared'
import { VendorApiError } from '../errors'
import type { KeenonCallTaskBody, KeenonRawPoint, KeenonTarget } from './api'
import { interpretKeenonCallback } from './webhook'

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

// ---------------------------------------------------------------------------
// Task status from Keenon (callbacks can stop before a task ends, e.g. a point on another floor)
// ---------------------------------------------------------------------------

export const NO_RECORD_MESSAGE = 'Keenon has no record of this task any more (no final update was received)'

/** A remote call the app should still check on. */
export function isOpenRemoteCall(task: RobotTask | null | undefined): task is RobotTask & { task_no: string } {
  return !!task?.task_no && task.type === 'Remote call' && !FINISHED_TASK_STATES.has(task.state)
}

export function endedTask(task: RobotTask, now: Date = new Date()): RobotTask {
  return { ...task, state: 'ended', error_message: NO_RECORD_MESSAGE, updated_at: now.toISOString() }
}

/** Keenon's answer when it doesn't know a task (parameter error), as opposed to an outage. */
export function isUnknownTaskError(err: unknown): boolean {
  return err instanceof VendorApiError && err.code === 610601
}

/**
 * Ask Keenon for an open remote call's status and return the updated task, or null when there's
 * nothing to check. Errors other than "unknown task" (outage, IP, rate limit) are thrown.
 */
export async function reconcileTask(
  task: RobotTask | null | undefined,
  robotSn: string,
  query: (taskNo: string) => Promise<Record<string, unknown> | null>,
  now: Date = new Date(),
): Promise<RobotTask | null> {
  if (!isOpenRemoteCall(task)) return null
  let data: Record<string, unknown> | null
  try {
    data = await query(task.task_no)
  } catch (err) {
    if (isUnknownTaskError(err)) return endedTask(task, now)
    throw err
  }
  if (!data || data.taskStatus === undefined || data.taskStatus === null) return endedTask(task, now)
  // Same shape as the CreateTask callback; the query names the robot `robotId` rather than robotSn.
  const meaning = interpretKeenonCallback({ bizType: 'CreateTask', data: { ...data, robotSn } }, now)
  return meaning.patch?.current_task ?? endedTask(task, now)
}
