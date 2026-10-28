import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { RobotPosition } from '../../src/types/api'
import type {
  KeenonRobotFloor,
  KeenonRobotMapSummary,
  KeenonRobotMapsDetail,
  KeenonScene,
} from '../../src/vendors/keenon/shared'
import { sampleErrors, type PositionAlignment } from '../../src/vendors/keenon/alignment'
import { fitTransform, pairErrors, type CalibrationPair, type PlanTransform } from '../../src/vendors/keenon/calibration'
import { HttpError, handler, json, methodNotAllowed, parseBody, requireAdmin } from '../lib/http'
import { db } from '../lib/supabaseAdmin'
import { VendorApiError } from '../vendors/errors'
import { keenonAdapter, keenonClientFor } from '../vendors/keenon/adapter'
import { getRobotLocation, getScenes } from '../vendors/keenon/api'
import { discoverRobotMaps, locationToPosition } from '../vendors/keenon/mapDiscovery'
import { currentScene, type SceneRow } from '../vendors/keenon/scene'
import { contextFor, loadConfig } from '../vendors/store'

// Keenon-only: which floors (maps) each Keenon robot knows, and which app floor each matches.

interface RobotRow {
  id: string
  external_id: string
  name: string | null
  model: string | null
  store_external_id: string | null
  position: RobotPosition | null
}


const ROBOT_COLUMNS = 'id, external_id, name, model, store_external_id, position'
const LOCATE_INTERVAL_MS = 2_500
const FLOOR_SUMMARY_COLUMNS = 'robot_id, scene_code, app_floor_id'

const CLEARED_CALIBRATION = {
  calib_scale_px_per_m: null,
  calib_rotation_rad: null,
  calib_origin_x_px: null,
  calib_origin_y_px: null,
  calib_pairs: null,
  calib_rms_m: null,
  calib_map_hash: null,
  calibrated_at: null,
}

type FloorRow = Omit<KeenonRobotFloor, 'calibration_stale'> & { calib_map_hash: string | null }

/** Fingerprint of the Keenon map a calibration was made against (image + point map versions). */
function mapHash(row: Pick<FloorRow, 'map_png' | 'map_versions'>): string {
  return createHash('sha256')
    .update(row.map_png ?? '')
    .update('|')
    .update([...(row.map_versions ?? [])].sort().join(','))
    .digest('hex')
}

function withCalibrationState(row: FloorRow): KeenonRobotFloor {
  const { calib_map_hash, ...floor } = row
  return { ...floor, calibration_stale: !!row.calibrated_at && calib_map_hash !== mapHash(row) }
}

async function keenonClient() {
  const config = await loadConfig(keenonAdapter.id)
  if (!config || !keenonAdapter.isConfigured(config)) {
    throw new HttpError(400, 'Keenon is not configured. Set it up in Vendors → Keenon first.')
  }
  return keenonClientFor(contextFor(config))
}

/** Vendor API failures → 502 with Keenon's plain-language message. */
async function callKeenon<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof VendorApiError) throw new HttpError(502, err.message)
    throw err
  }
}

async function storeNames(): Promise<Map<string, string | null>> {
  const { data, error } = await db().from('vendor_stores').select('external_id, name').eq('vendor', 'keenon')
  if (error) throw error
  return new Map((data as { external_id: string; name: string | null }[]).map((s) => [s.external_id, s.name]))
}

function summarize(
  robot: RobotRow,
  scene: SceneRow | undefined,
  floors: { scene_code: string; app_floor_id: string | null }[],
  stores: Map<string, string | null>,
): KeenonRobotMapSummary {
  const current = currentScene(scene)
  const inScene = floors.filter((f) => f.scene_code === current.code)
  return {
    robot_id: robot.id,
    external_id: robot.external_id,
    name: robot.name,
    model: robot.model,
    store_external_id: robot.store_external_id,
    store_name: robot.store_external_id ? (stores.get(robot.store_external_id) ?? null) : null,
    scene: current,
    detected_scene: { code: scene?.detected_scene_code ?? null, name: scene?.detected_scene_name ?? null },
    floors_found: inScene.length,
    floors_matched: inScene.filter((f) => f.app_floor_id).length,
    discovered_at: scene?.discovered_at ?? null,
    discovery_error: scene?.discovery_error ?? null,
  }
}

async function loadRobot(id: string): Promise<RobotRow> {
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'Robot not found')
  const { data, error } = await db().from('robots').select(ROBOT_COLUMNS).eq('id', id).eq('vendor', 'keenon').maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Robot not found')
  return data as RobotRow
}

async function loadScene(robotId: string): Promise<SceneRow | undefined> {
  const { data, error } = await db().from('keenon_robot_scenes').select('*').eq('robot_id', robotId).maybeSingle()
  if (error) throw error
  return (data as SceneRow | null) ?? undefined
}

async function listRobots(): Promise<Response> {
  const [robots, scenes, floors, stores] = await Promise.all([
    db().from('robots').select(ROBOT_COLUMNS).eq('vendor', 'keenon').order('name'),
    db().from('keenon_robot_scenes').select('*'),
    db().from('keenon_robot_floors').select(FLOOR_SUMMARY_COLUMNS),
    storeNames(),
  ])
  for (const r of [robots, scenes, floors]) if (r.error) throw r.error
  const sceneBy = new Map((scenes.data as SceneRow[]).map((s) => [s.robot_id, s]))
  const floorRows = floors.data as { robot_id: string; scene_code: string; app_floor_id: string | null }[]
  return json(
    (robots.data as RobotRow[]).map((r) =>
      summarize(r, sceneBy.get(r.id), floorRows.filter((f) => f.robot_id === r.id), stores),
    ),
  )
}

async function robotDetail(robotId: string): Promise<KeenonRobotMapsDetail> {
  const robot = await loadRobot(robotId)
  const scene = await loadScene(robot.id)
  const { data, error } = await db()
    .from('keenon_robot_floors')
    .select('*')
    .eq('robot_id', robot.id)
    .order('scene_code')
    .order('floor')
  if (error) throw error
  const all = (data as FloorRow[]).map(withCalibrationState)
  const sceneCode = currentScene(scene).code
  // Only the current scene's floors are shown; other scenes' floors are deleted at the next discovery.
  const floors = all.filter((f) => f.scene_code === sceneCode)
  return {
    robot: summarize(robot, scene, all, await storeNames()),
    position: robot.position,
    floors,
    other_scene_floors: all.length - floors.length,
  }
}

async function discover(robotId: string): Promise<Response> {
  const robot = await loadRobot(robotId)
  const scene = await loadScene(robot.id)
  const manual = scene?.manual_scene_code ? { code: scene.manual_scene_code, name: scene.manual_scene_name } : null
  const client = await keenonClient()

  let result
  try {
    result = await callKeenon(() => discoverRobotMaps(client, robot, manual))
  } catch (err) {
    await db()
      .from('keenon_robot_scenes')
      .upsert({ robot_id: robot.id, discovery_error: err instanceof Error ? err.message : String(err) })
    throw err
  }

  const now = new Date().toISOString()
  const { error: sceneError } = await db()
    .from('keenon_robot_scenes')
    .upsert({
      robot_id: robot.id,
      discovered_at: now,
      discovery_error: result.warnings.length ? result.warnings.join(' · ') : null,
      ...(result.scene.source === 'detected'
        ? { detected_scene_code: result.scene.code, detected_scene_name: result.scene.name }
        : {}),
    })
  if (sceneError) throw sceneError

  // Upsert without app_floor_id/matched_at, so existing matches are kept.
  for (const floor of result.floors) {
    const { error } = await db()
      .from('keenon_robot_floors')
      .upsert(
        { robot_id: robot.id, scene_code: result.scene.code, ...floor, last_seen_at: now },
        { onConflict: 'robot_id,scene_code,floor' },
      )
    if (error) throw error
  }

  // The scene is now confirmed: drop floors (and their matches/calibrations) of any other scene.
  const { error: cleanupError } = await db()
    .from('keenon_robot_floors')
    .delete()
    .eq('robot_id', robot.id)
    .neq('scene_code', result.scene.code)
  if (cleanupError) throw cleanupError

  if (result.position) {
    const { error } = await db().from('robots').update({ position: result.position }).eq('id', robot.id)
    if (error) throw error
  }
  return json(await robotDetail(robot.id))
}

const sceneSchema = z.object({
  scene_code: z.string().trim().min(1).max(64).nullable(),
  scene_name: z.string().trim().max(200).nullable().optional(),
})

async function setScene(robotId: string, req: Request): Promise<Response> {
  const robot = await loadRobot(robotId)
  const { scene_code, scene_name } = await parseBody(req, sceneSchema)
  const { error } = await db()
    .from('keenon_robot_scenes')
    .upsert({ robot_id: robot.id, manual_scene_code: scene_code, manual_scene_name: scene_code ? (scene_name ?? null) : null })
  if (error) throw error
  return json(await robotDetail(robot.id))
}

async function listScenes(storeId: string): Promise<Response> {
  if (!storeId || storeId.length > 100) throw new HttpError(404, 'Store not found')
  const client = await keenonClient()
  const scenes = await callKeenon(() => getScenes(client, storeId))
  const body: KeenonScene[] = scenes
    .filter((s) => s.sceneCode)
    .map((s) => ({ code: s.sceneCode, name: s.sceneName ?? s.sceneCode }))
  return json(body)
}

const matchSchema = z.object({ app_floor_id: z.uuid().nullable() })

async function matchFloor(floorRowId: string, req: Request): Promise<Response> {
  if (!z.uuid().safeParse(floorRowId).success) throw new HttpError(404, 'Floor not found')
  const { app_floor_id } = await parseBody(req, matchSchema)
  if (app_floor_id) {
    const { data, error } = await db().from('floors').select('id').eq('id', app_floor_id).maybeSingle()
    if (error) throw error
    if (!data) throw new HttpError(400, 'That app floor no longer exists')
  }
  const current = await loadFloorRow(floorRowId)
  const changed = current.app_floor_id !== app_floor_id
  const { data, error } = await db()
    .from('keenon_robot_floors')
    .update({
      app_floor_id,
      matched_at: app_floor_id ? new Date().toISOString() : null,
      // A calibration belongs to one app floor plan; matching another invalidates it.
      ...(changed ? CLEARED_CALIBRATION : {}),
    })
    .eq('id', floorRowId)
    .select('*')
    .single()
  if (error) throw error
  return json(withCalibrationState(data as FloorRow))
}

async function loadFloorRow(floorRowId: string): Promise<FloorRow> {
  if (!z.uuid().safeParse(floorRowId).success) throw new HttpError(404, 'Floor not found')
  const { data, error } = await db().from('keenon_robot_floors').select('*').eq('id', floorRowId).maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Floor not found')
  return data as FloorRow
}

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() })
const calibrationSchema = z.object({
  scale: z.number().finite().positive(),
  rotation: z.number().finite(),
  origin_x: z.number().finite(),
  origin_y: z.number().finite(),
  pairs: z
    .array(z.object({ robot: pointSchema, plan: pointSchema, point_name: z.string().max(200).nullable().optional() }))
    .min(2, 'At least 2 point pairs are needed')
    .max(50),
})

async function saveCalibration(floorRowId: string, req: Request): Promise<Response> {
  const row = await loadFloorRow(floorRowId)
  if (!row.app_floor_id) throw new HttpError(400, 'Match this floor to an app floor before calibrating.')
  if (!row.map_png) throw new HttpError(400, 'This floor has no Keenon map image to calibrate against.')
  const input = await parseBody(req, calibrationSchema)
  const pairs: CalibrationPair[] = input.pairs

  // The pairs must define a transform on their own; the saved transform may be hand-tuned.
  try {
    fitTransform(pairs)
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'Invalid point pairs')
  }
  const transform: PlanTransform = {
    scale: input.scale,
    rotation: input.rotation,
    origin_x: input.origin_x,
    origin_y: input.origin_y,
  }
  const { rms_m } = pairErrors(transform, pairs)

  const { data, error } = await db()
    .from('keenon_robot_floors')
    .update({
      calib_scale_px_per_m: transform.scale,
      calib_rotation_rad: transform.rotation,
      calib_origin_x_px: transform.origin_x,
      calib_origin_y_px: transform.origin_y,
      calib_pairs: pairs,
      calib_rms_m: rms_m,
      calib_map_hash: mapHash(row),
      calibrated_at: new Date().toISOString(),
    })
    .eq('id', floorRowId)
    .select('*')
    .single()
  if (error) throw error
  return json(withCalibrationState(data as FloorRow))
}

async function clearCalibration(floorRowId: string): Promise<Response> {
  await loadFloorRow(floorRowId)
  const { data, error } = await db()
    .from('keenon_robot_floors')
    .update(CLEARED_CALIBRATION)
    .eq('id', floorRowId)
    .select('*')
    .single()
  if (error) throw error
  return json(withCalibrationState(data as FloorRow))
}

const alignmentSchema = z.object({
  rotation: z.number().finite(),
  offset_x: z.number().finite(),
  offset_y: z.number().finite(),
  mirror: z.boolean(),
  samples: z.array(z.object({ reported: pointSchema, map: pointSchema })).max(50).default([]),
})

async function saveAlignment(floorRowId: string, req: Request): Promise<Response> {
  await loadFloorRow(floorRowId)
  const input = await parseBody(req, alignmentSchema)
  const alignment: PositionAlignment = {
    rotation: input.rotation,
    offset_x: input.offset_x,
    offset_y: input.offset_y,
    mirror: input.mirror,
  }
  const rms = input.samples.length ? sampleErrors(alignment, input.samples).rms_m : null
  const { data, error } = await db()
    .from('keenon_robot_floors')
    .update({
      align_rotation_rad: alignment.rotation,
      align_offset_x_m: alignment.offset_x,
      align_offset_y_m: alignment.offset_y,
      align_mirror: alignment.mirror,
      align_samples: input.samples,
      align_rms_m: rms,
      aligned_at: new Date().toISOString(),
    })
    .eq('id', floorRowId)
    .select('*')
    .single()
  if (error) throw error
  return json(withCalibrationState(data as FloorRow))
}

async function clearAlignment(floorRowId: string): Promise<Response> {
  await loadFloorRow(floorRowId)
  const { data, error } = await db()
    .from('keenon_robot_floors')
    .update({
      align_rotation_rad: null,
      align_offset_x_m: null,
      align_offset_y_m: null,
      align_mirror: null,
      align_samples: null,
      align_rms_m: null,
      aligned_at: null,
    })
    .eq('id', floorRowId)
    .select('*')
    .single()
  if (error) throw error
  return json(withCalibrationState(data as FloorRow))
}

/** Just the robot's current position (much cheaper than full discovery). */
async function locate(robotId: string): Promise<Response> {
  const robot = await loadRobot(robotId)
  // Keenon recommends ~3 s between status queries. A position fetched moments ago (by this
  // screen or the Map page) is returned as is rather than asking Keenon again.
  const lastFetch = robot.position?.fetched_at ? Date.parse(robot.position.fetched_at) : 0
  if (robot.position && Date.now() - lastFetch < LOCATE_INTERVAL_MS) return json(robot.position)

  const client = await keenonClient()
  const location = await callKeenon(() => getRobotLocation(client, robot.external_id))
  if (!location) throw new HttpError(502, 'Keenon did not report a position for this robot.')
  const position = { ...locationToPosition(location), fetched_at: new Date().toISOString() }
  const { error } = await db().from('robots').update({ position }).eq('id', robot.id)
  if (error) throw error
  return json(position)
}

export default handler(async (req) => {
  await requireAdmin(req)
  // /api/keenon/<section>/<id>/<action>; parsed by hand so one handler serves every shape.
  const [, , section, id, action, ...rest] = new URL(req.url).pathname.split('/').filter(Boolean)
  if (rest.length) throw new HttpError(404, 'Not found')

  if (section === 'robots' && !id) {
    if (req.method !== 'GET') methodNotAllowed()
    return listRobots()
  }
  if (section === 'robots' && id) {
    switch (action) {
      case 'floors':
        if (req.method !== 'GET') methodNotAllowed()
        return json(await robotDetail(id))
      case 'discover':
        if (req.method !== 'POST') methodNotAllowed()
        return discover(id)
      case 'scene':
        if (req.method !== 'PUT') methodNotAllowed()
        return setScene(id, req)
      case 'locate':
        if (req.method !== 'POST') methodNotAllowed()
        return locate(id)
    }
  }
  if (section === 'stores' && id && action === 'scenes') {
    if (req.method !== 'GET') methodNotAllowed()
    return listScenes(decodeURIComponent(id))
  }
  if (section === 'robot-floors' && id && !action) {
    if (req.method !== 'PUT') methodNotAllowed()
    return matchFloor(id, req)
  }
  if (section === 'robot-floors' && id && action === 'calibration') {
    if (req.method === 'PUT') return saveCalibration(id, req)
    if (req.method === 'DELETE') return clearCalibration(id)
    methodNotAllowed()
  }
  if (section === 'robot-floors' && id && action === 'alignment') {
    if (req.method === 'PUT') return saveAlignment(id, req)
    if (req.method === 'DELETE') return clearAlignment(id)
    methodNotAllowed()
  }
  throw new HttpError(404, 'Not found')
})
