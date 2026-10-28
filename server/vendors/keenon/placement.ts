// Keenon robots on the app's floor plans:
//   plan pixel = calibration(alignment(reported position))
// using the floor of the robot's current scene that it reports being on.

import type { RobotPosition } from '../../../src/types/api'
import { alignHeading, alignPosition } from '../../../src/vendors/keenon/alignment'
import { headingOnPlan, robotToPlan } from '../../../src/vendors/keenon/calibration'
import { floorAlignment, floorCalibration } from '../../../src/vendors/keenon/floorTransforms'
import type { KeenonRobotFloor } from '../../../src/vendors/keenon/shared'
import { db } from '../../lib/supabaseAdmin'
import type { MapPlacer, MapRobotRow, RobotPlacement } from '../types'
import { getRobotLocation } from './api'
import type { KeenonClient } from './client'
import { KeenonError } from './client'
import { locationToPosition } from './mapDiscovery'
import { currentScene, type SceneRow } from './scene'

export type PlacementFloor = Pick<
  KeenonRobotFloor,
  | 'scene_code'
  | 'floor'
  | 'app_floor_id'
  | 'align_rotation_rad'
  | 'align_offset_x_m'
  | 'align_offset_y_m'
  | 'align_mirror'
  | 'calib_scale_px_per_m'
  | 'calib_rotation_rad'
  | 'calib_origin_x_px'
  | 'calib_origin_y_px'
>

const FLOOR_COLUMNS =
  'robot_id, scene_code, floor, app_floor_id, align_rotation_rad, align_offset_x_m, align_offset_y_m, align_mirror, ' +
  'calib_scale_px_per_m, calib_rotation_rad, calib_origin_x_px, calib_origin_y_px'




/** A floor that's matched, aligned and calibrated, so robots on it can be drawn. */
export function isFloorReady(floor: PlacementFloor): boolean {
  return !!floor.app_floor_id && !!floorAlignment(floor) && !!floorCalibration(floor)
}

/** Whether any floor of the robot's current scene is ready (worth asking Keenon where it is). */
export function hasReadyFloor(sceneCode: string | null, floors: PlacementFloor[]): boolean {
  return !!sceneCode && floors.some((f) => f.scene_code === sceneCode && isFloorReady(f))
}

export function placeKeenonRobot(
  position: RobotPosition | null,
  sceneCode: string | null,
  floors: PlacementFloor[],
): RobotPlacement {
  if (!sceneCode) return { reason: 'its scene is unknown: run Discover on its robot maps page' }
  const inScene = floors.filter((f) => f.scene_code === sceneCode)
  if (!inScene.length) return { reason: `no floors found for scene ${sceneCode}: run Discover on its robot maps page` }
  if (!position) {
    // Robots are only located once a floor is set up, so say what's missing first.
    return hasReadyFloor(sceneCode, floors)
      ? { reason: 'no position yet' }
      : { reason: 'none of its floors is set up yet (match, align position and calibrate)' }
  }

  const floor = inScene.find((f) => String(f.floor) === position.floor)
  if (!floor) return { reason: `it reports floor ${position.floor ?? '?'}, which isn't in its scene` }
  if (!floor.app_floor_id) return { reason: `floor ${floor.floor} isn't matched to an app floor` }
  const alignment = floorAlignment(floor)
  if (!alignment) return { reason: `floor ${floor.floor}'s position isn't aligned` }
  const calibration = floorCalibration(floor)
  if (!calibration) return { reason: `floor ${floor.floor} isn't calibrated to its floor plan` }

  const plan = robotToPlan(calibration, alignPosition(alignment, position))
  return {
    floor_id: floor.app_floor_id,
    x_px: plan.x,
    y_px: plan.y,
    heading_rad:
      position.heading_rad !== null ? headingOnPlan(calibration, alignHeading(alignment, position.heading_rad)) : null,
  }
}

/** Current scene code and floors of each robot. */
async function loadSetup(robotIds: string[]): Promise<Map<string, { sceneCode: string | null; floors: PlacementFloor[] }>> {
  const setup = new Map(robotIds.map((id) => [id, { sceneCode: null as string | null, floors: [] as PlacementFloor[] }]))
  if (!robotIds.length) return setup
  const [scenes, floors] = await Promise.all([
    db().from('keenon_robot_scenes').select('*').in('robot_id', robotIds),
    db().from('keenon_robot_floors').select(FLOOR_COLUMNS).in('robot_id', robotIds),
  ])
  if (scenes.error) throw scenes.error
  if (floors.error) throw floors.error
  for (const s of scenes.data as SceneRow[]) {
    const entry = setup.get(s.robot_id)
    if (entry) entry.sceneCode = currentScene(s).code
  }
  for (const f of floors.data as unknown as (PlacementFloor & { robot_id: string })[]) {
    setup.get(f.robot_id)?.floors.push(f)
  }
  return setup
}

/** Load the floor setup of these robots once; then locate/place them without more queries. */
export async function prepareKeenonPlacer(robots: MapRobotRow[]): Promise<MapPlacer> {
  const setup = await loadSetup(robots.map((r) => r.id))
  return {
    isLocatable(robot) {
      const s = setup.get(robot.id)
      return robot.online !== false && !!s && hasReadyFloor(s.sceneCode, s.floors)
    },
    place(robot) {
      const s = setup.get(robot.id)
      return placeKeenonRobot(robot.position, s?.sceneCode ?? null, s?.floors ?? [])
    },
  }
}

/** Location calls in flight at once: quicker than one by one, still gentle on Keenon's rate limits. */
const LOCATE_CONCURRENCY = 3

/**
 * Ask Keenon where each robot is. A robot that fails is skipped; if every robot fails,
 * the first error is thrown. Account-level problems (IP not whitelisted, bad credentials)
 * stop the remaining calls.
 */
export async function locateKeenonRobots(client: KeenonClient, robots: MapRobotRow[]): Promise<Map<string, RobotPosition>> {
  const positions = new Map<string, RobotPosition>()
  let firstError: unknown = null
  let stop = false
  const queue = [...robots]
  async function worker() {
    for (let robot = queue.shift(); robot && !stop; robot = queue.shift()) {
      try {
        const location = await getRobotLocation(client, robot.external_id)
        if (location) positions.set(robot.id, locationToPosition(location))
      } catch (err) {
        firstError ??= err
        if (err instanceof KeenonError && (err.code === 617000 || err.httpStatus === 401)) stop = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOCATE_CONCURRENCY, robots.length) }, worker))
  if (!positions.size && firstError) throw firstError
  return positions
}
