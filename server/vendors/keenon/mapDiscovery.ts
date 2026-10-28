// Discover which floors (maps) a Keenon robot's scene has, with each floor's map image
// and named points. Keenon has no "list floors of a scene" API, so floors are combined from:
//  - the cleaning-area list (cleaning robots list their floors directly),
//  - probing the map-points API for floors 1..N,
//  - the robot's current floor (location API).

import type { RobotPosition } from '../../../src/types/api'
import type { KeenonMapPoint } from '../../../src/vendors/keenon/shared'
import {
  getCleanAreas,
  getMapImage,
  getMapPoints,
  getRobotLocation,
  getRobotStatus,
  type KeenonLocation,
  type KeenonRawPoint,
} from './api'
import { KeenonError, type KeenonClient } from './client'

export const MAX_PROBED_FLOOR = 10

/** Errors that mean "stop talking to Keenon now" rather than "this floor/feature isn't there". */
const FATAL_CODES = new Set([610001, 610401, 617000, 610609])

function isFatal(err: unknown): boolean {
  return err instanceof KeenonError && (err.code === null || FATAL_CODES.has(err.code))
}

export type FloorSource = 'location' | 'clean-areas' | 'points'

export interface DiscoveredFloor {
  floor: number
  floor_label: string | null
  building: string | null
  map_png: string | null
  map_width: number | null
  map_height: number | null
  origin_x_m: number | null
  origin_y_m: number | null
  is_dynamic: boolean | null
  points: KeenonMapPoint[]
  map_versions: string[]
  sources: FloorSource[]
}

export interface DiscoveryResult {
  scene: { code: string; name: string | null; source: 'manual' | 'detected' }
  floors: DiscoveredFloor[]
  position: RobotPosition | null
  warnings: string[]
}

export interface DiscoveryRobot {
  external_id: string
  store_external_id: string | null
}

const intFloor = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isInteger(n) ? n : null
}

export function toMapPoint(raw: KeenonRawPoint): KeenonMapPoint | null {
  if (typeof raw.positionX !== 'number' || typeof raw.positionY !== 'number') return null
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    id: raw.targetId ?? raw.id ?? null,
    name: text(raw.name) ?? `Point ${raw.targetId ?? raw.id ?? ''}`.trim(),
    type: text(raw.type),
    x_px: raw.positionX,
    y_px: raw.positionY,
    map_md5: text(raw.mapMd5),
    floor_label: text(raw.floorInfo),
    building: text(raw.buildingInfo),
  }
}

/** Combine floor numbers from each source into a sorted list with their sources. Pure. */
export function mergeFloorSources(sources: Partial<Record<FloorSource, Iterable<number>>>): Map<number, FloorSource[]> {
  const merged = new Map<number, FloorSource[]>()
  for (const [source, floors] of Object.entries(sources) as [FloorSource, Iterable<number>][]) {
    for (const floor of floors) {
      const list = merged.get(floor) ?? []
      if (!list.includes(source)) list.push(source)
      merged.set(floor, list)
    }
  }
  return new Map([...merged.entries()].sort(([a], [b]) => a - b))
}

/** Most common non-empty value (floor labels / buildings vary per point). */
function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

export function locationToPosition(loc: KeenonLocation): RobotPosition {
  return {
    floor: loc.floor,
    x: loc.x,
    y: loc.y,
    heading_rad: loc.heading_rad,
    reported_at: loc.reported_at,
    source: 'keenon:location',
  }
}

export async function discoverRobotMaps(
  client: KeenonClient,
  robot: DiscoveryRobot,
  manualScene: { code: string; name: string | null } | null,
): Promise<DiscoveryResult> {
  const warnings: string[] = []

  // 1. Scene: admin override, else what the robot reports.
  let scene: DiscoveryResult['scene']
  if (manualScene) {
    scene = { ...manualScene, source: 'manual' }
  } else {
    const status = await getRobotStatus(client, robot.external_id)
    if (!status?.sceneCode) {
      throw new KeenonError(null, "Keenon didn't report a scene for this robot. Pick the scene manually and try again.")
    }
    scene = { code: status.sceneCode, name: status.sceneName ?? null, source: 'detected' }
  }

  // 2a. Current floor (and position) from the location API.
  let position: RobotPosition | null = null
  const locationFloors: number[] = []
  try {
    const loc = await getRobotLocation(client, robot.external_id)
    if (loc) {
      position = locationToPosition(loc)
      const f = intFloor(loc.floor)
      if (f !== null) locationFloors.push(f)
    }
  } catch (err) {
    if (isFatal(err)) throw err
    warnings.push(`Location unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2b. Cleaning robots list their floors directly (other robots answer with an error or nothing).
  const cleanFloors: number[] = []
  if (robot.store_external_id) {
    try {
      for (const area of await getCleanAreas(client, robot.store_external_id, robot.external_id)) {
        const f = intFloor(area.floor)
        if (f !== null) cleanFloors.push(f)
      }
    } catch (err) {
      if (isFatal(err)) throw err
    }
  }

  // 2c. Probe floors 1..N for named points (sequential: Keenon rate-limits).
  const pointsByFloor = new Map<number, KeenonRawPoint[]>()
  for (let floor = 1; floor <= MAX_PROBED_FLOOR; floor++) {
    try {
      const points = await getMapPoints(client, scene.code, floor)
      if (points.length) pointsByFloor.set(floor, points)
    } catch (err) {
      if (isFatal(err)) throw err
    }
  }

  const floors = mergeFloorSources({
    location: locationFloors,
    'clean-areas': cleanFloors,
    points: pointsByFloor.keys(),
  })

  // 3. Map image + points for every floor found.
  const result: DiscoveredFloor[] = []
  for (const [floor, sources] of floors) {
    let raw = pointsByFloor.get(floor)
    if (!raw) {
      try {
        raw = await getMapPoints(client, scene.code, floor)
      } catch (err) {
        if (isFatal(err)) throw err
        raw = []
      }
    }
    const points = raw.map(toMapPoint).filter((p): p is KeenonMapPoint => p !== null)

    let image = null
    try {
      image = await getMapImage(client, scene.code, floor)
    } catch (err) {
      if (isFatal(err)) throw err
      warnings.push(`Floor ${floor}: map image unavailable (${err instanceof Error ? err.message : String(err)})`)
    }
    const origin = image?.originPosition
    const hasMap = typeof image?.content === 'string' && image.content.length > 0

    result.push({
      floor,
      floor_label: mostCommon(points.map((p) => p.floor_label)),
      building: mostCommon(points.map((p) => p.building)),
      map_png: hasMap ? image!.content! : null,
      map_width: typeof origin?.width === 'number' ? Math.round(origin.width) : null,
      map_height: typeof origin?.height === 'number' ? Math.round(origin.height) : null,
      origin_x_m: typeof origin?.originX === 'number' ? origin.originX : null,
      origin_y_m: typeof origin?.originY === 'number' ? origin.originY : null,
      is_dynamic: typeof origin?.isDynamic === 'boolean' ? origin.isDynamic : null,
      points,
      map_versions: [...new Set(points.map((p) => p.map_md5).filter((v): v is string => !!v))],
      sources,
    })
  }

  // Keenon may return the same image for several floors (seen in practice: identical PNG and
  // origin for floors 1 and 2), so flag it; a human should check before matching.
  const byImage = new Map<string, number[]>()
  for (const f of result) if (f.map_png) byImage.set(f.map_png, [...(byImage.get(f.map_png) ?? []), f.floor])
  for (const floors of byImage.values()) {
    if (floors.length > 1) {
      warnings.push(`Floors ${floors.join(' and ')} returned the same map image; Keenon may not have a separate map for each`)
    }
  }

  return { scene, floors: result, position, warnings }
}
