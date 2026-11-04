// Coordinate conversions for Keenon maps. Three spaces:
//  - robot metres: what the robot reports (location API, callbacks); y up.
//  - map pixels:   Keenon's named points; pixels from the map origin (bottom-left), y up.
//  - image pixels: the PNG as displayed; (0,0) at the top-left, y down.

import type { PlanCalibration, Point } from '../../lib/coords'
import { KEENON_MAP_RESOLUTION } from './shared'

export interface KeenonMapFrame {
  map_height: number
  origin_x_m: number
  origin_y_m: number
}

export function mapPixelToMeters(map: KeenonMapFrame, p: Point, resolution = KEENON_MAP_RESOLUTION): Point {
  return { x: map.origin_x_m + p.x * resolution, y: map.origin_y_m + p.y * resolution }
}

export function metersToMapPixel(map: KeenonMapFrame, m: Point, resolution = KEENON_MAP_RESOLUTION): Point {
  return { x: (m.x - map.origin_x_m) / resolution, y: (m.y - map.origin_y_m) / resolution }
}

/** Map pixel (y up from the origin) → image pixel (y down from the top). */
export function mapPixelToImage(map: KeenonMapFrame, p: Point): Point {
  return { x: p.x, y: map.map_height - p.y }
}

/**
 * Calibration that lets the generic PlanMap show a Keenon map with its cursor readout
 * in robot metres (PlanMap's world frame = the robot's frame).
 */
export function keenonMapCalibration(map: KeenonMapFrame, resolution = KEENON_MAP_RESOLUTION): PlanCalibration {
  return {
    scale_m_per_px: resolution,
    origin_x_px: -map.origin_x_m / resolution,
    origin_y_px: map.map_height + map.origin_y_m / resolution,
  }
}

/** A floor's frame plus how its named points are measured. */
export interface KeenonPointsFrame extends KeenonMapFrame {
  /** Named points' y is measured from the top of the image instead of up from the origin. */
  points_flipped?: boolean | null
}

/**
 * A named point (map pixels) → robot metres. Most maps measure y up from the origin; on some
 * (seen on the S100) y is measured from the top of the image, which the floor's switch corrects.
 */
export function namedPointToMeters(map: KeenonPointsFrame, p: Point, resolution = KEENON_MAP_RESOLUTION): Point {
  return mapPixelToMeters(map, map.points_flipped ? { x: p.x, y: map.map_height - p.y } : p, resolution)
}

/** Distance (m) between the robot's aligned home and the floor's home point, beyond which points look wrong. */
const FLIP_HINT_DISTANCE_M = 2

/**
 * Whether the floor's named points look upside down: its home point (charging pile or origin) is
 * far from where the alignment puts the robot's origin (reported 0,0), but close once flipped.
 * Needs an alignment and a home point; otherwise there's nothing to compare, so false.
 */
export function pointsLookFlipped(
  floor: KeenonPointsFrame & {
    align_offset_x_m: number | null
    align_offset_y_m: number | null
    points: { type: string | null; name: string; x_px: number; y_px: number }[]
  },
): boolean {
  if (floor.align_offset_x_m === null || floor.align_offset_y_m === null) return false
  const home = { x: floor.align_offset_x_m, y: floor.align_offset_y_m } // alignment of reported (0, 0)
  const homePoints = floor.points.filter((p) => /^(charge|origin)$/i.test(p.type ?? ''))
  if (!homePoints.length) return false
  const distance = (flipped: boolean) =>
    Math.min(
      ...homePoints.map((p) => {
        const m = namedPointToMeters({ ...floor, points_flipped: flipped }, { x: p.x_px, y: p.y_px })
        return Math.hypot(m.x - home.x, m.y - home.y)
      }),
    )
  const asDrawn = distance(!!floor.points_flipped)
  return asDrawn > FLIP_HINT_DISTANCE_M && distance(!floor.points_flipped) < asDrawn / 2
}
