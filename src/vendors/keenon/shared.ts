import type { RobotPosition } from '../../types/api'

// Keenon constants shared by the browser config page and the Netlify Functions.

export const KEENON_REGIONS = {
  global: { label: 'Global', baseUrl: 'https://www.robotkeenon.com' },
  cn: { label: 'China', baseUrl: 'https://console.peanut.keenonrobot.com' },
  eu: { label: 'Europe', baseUrl: 'https://es.robotkeenon.com' },
  jp: { label: 'Japan', baseUrl: 'https://cloud.robotkeenon.com' },
} as const

export type KeenonRegion = keyof typeof KEENON_REGIONS | 'custom'

/** The only grant type Keenon's token endpoint accepts. */
export const KEENON_GRANT_TYPE = 'client_credentials'

export interface KeenonSettings {
  region: KeenonRegion
  custom_base_url: string
  client_id: string
  /** Reject callbacks without a valid X-Signature (Keenon support must enable signing first). */
  require_signature: boolean
  /** Stores whose robots are synced. Empty = all stores. */
  store_ids: string[]
}

export const KEENON_SECRET_FIELDS = ['client_secret'] as const

export function keenonBaseUrl(settings: Pick<KeenonSettings, 'region' | 'custom_base_url'>): string | null {
  if (settings.region === 'custom') return settings.custom_base_url.trim().replace(/\/+$/, '') || null
  return KEENON_REGIONS[settings.region]?.baseUrl ?? null
}

// ---------------------------------------------------------------------------
// Robot maps (scenes → floors → Keenon map images)
// ---------------------------------------------------------------------------

/**
 * Metres per map pixel. Keenon doesn't document it; 0.05 m/px (the usual robot-map
 * resolution) matched a docked robot's reported position against its charging-pile point.
 */
export const KEENON_MAP_RESOLUTION = 0.05

/** A named point on a Keenon map, in map pixels measured from the map origin (y up). */
export interface KeenonMapPoint {
  id: number | null
  name: string
  type: string | null
  x_px: number
  y_px: number
  map_md5: string | null
  floor_label: string | null
  building: string | null
}

/** One Keenon floor (map) of a robot's scene, and the app floor it's matched to. */
export interface KeenonRobotFloor {
  id: string
  robot_id: string
  scene_code: string
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
  sources: string[]
  last_seen_at: string
  app_floor_id: string | null
  matched_at: string | null
  /** Calibration to the matched app floor plan (null = not calibrated). See calibration.ts. */
  calib_scale_px_per_m: number | null
  calib_rotation_rad: number | null
  calib_origin_x_px: number | null
  calib_origin_y_px: number | null
  calib_pairs: { robot: { x: number; y: number }; plan: { x: number; y: number }; point_name?: string | null }[] | null
  calib_rms_m: number | null
  calibrated_at: string | null
  /** Keenon's map changed (image or point versions) since the calibration was made. */
  calibration_stale: boolean
  /** Reported position → Keenon map frame (null = not aligned). See alignment.ts. */
  align_rotation_rad: number | null
  align_offset_x_m: number | null
  align_offset_y_m: number | null
  align_mirror: boolean | null
  align_samples: { reported: { x: number; y: number }; map: { x: number; y: number } }[] | null
  align_rms_m: number | null
  aligned_at: string | null
}

export interface KeenonSceneInfo {
  code: string | null
  name: string | null
  /** 'manual' = picked by an admin; 'detected' = reported by the robot. */
  source: 'manual' | 'detected' | null
}

export interface KeenonRobotMapSummary {
  robot_id: string
  external_id: string
  name: string | null
  model: string | null
  store_external_id: string | null
  store_name: string | null
  scene: KeenonSceneInfo
  detected_scene: { code: string | null; name: string | null }
  floors_found: number
  floors_matched: number
  discovered_at: string | null
  discovery_error: string | null
}

export interface KeenonRobotMapsDetail {
  robot: KeenonRobotMapSummary
  position: RobotPosition | null
  /** Floors of the robot's current scene. */
  floors: KeenonRobotFloor[]
  /** Floors still stored from a previous scene (deleted at the next discovery). */
  other_scene_floors: number
}

export interface KeenonScene {
  code: string
  name: string
}

// ---------------------------------------------------------------------------
// Remote call tasks ("Send task": send a robot to a point)
// ---------------------------------------------------------------------------

/** Robots that take remote call tasks from the app. Only the S100 for now. */
export function canTakeTasks(model: string | null | undefined): boolean {
  return !!model && model.toUpperCase().includes('S100')
}

/** A point a robot can be sent to: a "normal" map point with the target-list ids a call needs. */
export interface KeenonTaskPoint {
  uuid: string
  point_id: string
  name: string
  area: string | null
}

export interface KeenonTaskPoints {
  scene_code: string
  floor: number
  points: KeenonTaskPoint[]
  /** "normal" points on this floor with no entry in the scene's target list (can't be sent to). */
  unmatched: number
}

/** A floor the robot can be sent to, from its discovered floors in the current scene. */
export interface KeenonTaskFloor {
  floor: number
  label: string | null
  /** The robot was last seen on this floor. */
  current: boolean
}

export interface KeenonTaskFloors {
  scene_code: string | null
  floors: KeenonTaskFloor[]
}

export interface KeenonTaskSent {
  task_no: string
  queue_position: number | null
}
