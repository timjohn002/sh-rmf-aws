// Check open remote-call tasks with Keenon and save what it says. Callbacks alone can leave a task
// "in progress" for good (Keenon stops reporting, e.g. for a point on another floor, or after a
// cancel), so the Robots page Refresh and the Send task dialog ask Keenon directly.

import type { RobotTask } from '../../../src/types/api'
import { db } from '../../lib/supabaseAdmin'
import { applyRobotPatch } from '../store'
import { getCallTask } from './api'
import type { KeenonClient } from './client'
import { isOpenRemoteCall, reconcileTask } from './tasks'

/** Returns how many tasks were updated. One Keenon call per open task, one after the other. */
export async function reconcileOpenTasks(client: KeenonClient, onlyRobotSn?: string): Promise<number> {
  let query = db().from('robots').select('external_id, current_task').eq('vendor', 'keenon')
  if (onlyRobotSn) query = query.eq('external_id', onlyRobotSn)
  const { data, error } = await query
  if (error) throw error

  let updated = 0
  for (const robot of data as { external_id: string; current_task: RobotTask | null }[]) {
    if (!isOpenRemoteCall(robot.current_task)) continue
    const task = await reconcileTask(robot.current_task, robot.external_id, (taskNo) => getCallTask(client, taskNo))
    if (!task) continue
    await applyRobotPatch('keenon', robot.external_id, { current_task: task })
    updated++
  }
  return updated
}
