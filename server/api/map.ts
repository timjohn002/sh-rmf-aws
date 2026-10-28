import type { RobotPosition } from '../../src/types/api'
import { handler, json, methodNotAllowed, requireUser } from '../lib/http'
import { db } from '../lib/supabaseAdmin'
import { VENDORS } from '../vendors/index'
import { buildMapRobots } from '../vendors/mapRobots'
import { contextFor, loadConfig } from '../vendors/store'
import type { MapRobotRow } from '../vendors/types'

// Vendors that couldn't be reached recently (per warm function instance).
const backoff = new Map<string, { until: number; message: string }>()

export default handler(async (req) => {
  await requireUser(req)
  if (req.method !== 'GET') methodNotAllowed()

  const body = await buildMapRobots({
    adapters: VENDORS,
    async loadRobots() {
      const { data, error } = await db().from('robots').select('id, vendor, external_id, name, model, online, position')
      if (error) throw error
      return data as MapRobotRow[]
    },
    loadConfig,
    contextFor,
    async savePosition(robotId: string, position: RobotPosition) {
      const { error } = await db().from('robots').update({ position }).eq('id', robotId)
      if (error) throw error
    },
    now: Date.now,
    backoff,
  })
  return json(body)
})
