import type { KeenonClient } from './client'
import type { KeenonRobot, KeenonRobotStatus, KeenonStore } from './types'

/** Keenon returns lists either bare or wrapped as `{ list: [...] }`. */
function asList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && Array.isArray((data as { list?: unknown }).list)) {
    return (data as { list: T[] }).list
  }
  return []
}

export async function getStores(client: KeenonClient): Promise<KeenonStore[]> {
  return asList<KeenonStore>(await client.get('/api/open/data/v1/store/list'))
}

export async function getRobots(client: KeenonClient, storeId: string): Promise<KeenonRobot[]> {
  return asList<KeenonRobot>(await client.get('/api/open/data/v1/store/robot/list', { storeId }))
}

export async function getRobotStatus(client: KeenonClient, robotId: string): Promise<KeenonRobotStatus | null> {
  const data = await client.get<unknown>('/api/open/scene/v1/robot/status', { robotId })
  const list = asList<KeenonRobotStatus>(data)
  if (list.length) return list[0]
  return data && typeof data === 'object' ? (data as KeenonRobotStatus) : null
}

export async function getBatteryLevel(client: KeenonClient, robotSn: string): Promise<number | null> {
  const data = await client.get<{ batteryLevel?: number }>('/api/open/custom/robot/battery/level', { robotSn })
  return typeof data?.batteryLevel === 'number' ? data.batteryLevel : null
}

export async function getCleanStatus(client: KeenonClient, robotSn: string): Promise<Record<string, unknown> | null> {
  const data = await client.get<unknown>('/api/open/custom/clean/robot/status', { robotSn })
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null
}

// ---------------------------------------------------------------------------
// Scenes, maps and positions
// ---------------------------------------------------------------------------

export interface KeenonSceneRow {
  sceneCode: string
  sceneName?: string
}

export async function getScenes(client: KeenonClient, storeId: string): Promise<KeenonSceneRow[]> {
  return asList<KeenonSceneRow>(await client.get('/api/open/scene/v1/info/list', { storeId }))
}

/** Raw named point from `/custom/robot/map/position` (map pixels from the origin, y up). */
export interface KeenonRawPoint {
  id?: number
  targetId?: number
  name?: string
  type?: string
  floor?: number | string
  mapMd5?: string
  positionX?: number
  positionY?: number
  floorInfo?: string
  buildingInfo?: string
}

export async function getMapPoints(client: KeenonClient, sceneCode: string, floor: number): Promise<KeenonRawPoint[]> {
  const data = await client.get<{ targetList?: KeenonRawPoint[] }>('/api/open/custom/robot/map/position', {
    sceneCode,
    floorInfo: floor,
  })
  return Array.isArray(data?.targetList) ? data.targetList : []
}

export interface KeenonMapImage {
  content?: string
  originPosition?: { isDynamic?: boolean; width?: number; height?: number; originX?: number; originY?: number }
}

export async function getMapImage(client: KeenonClient, sceneCode: string, floor: number): Promise<KeenonMapImage | null> {
  const data = await client.get<KeenonMapImage>('/api/open/custom/robot/map', { sceneCode, floorInfo: floor })
  return data && typeof data === 'object' ? data : null
}

export interface KeenonCleanArea {
  mapId?: string
  floor?: number | string
  areaNameList?: string[]
}

export async function getCleanAreas(client: KeenonClient, storeId: string, robotSn: string): Promise<KeenonCleanArea[]> {
  const data = await client.get<{ entities?: KeenonCleanArea[] }>('/api/open/custom/clean/robot/area/list', {
    storeId,
    robotSn,
    pageSize: 100,
  })
  return Array.isArray(data?.entities) ? data.entities : []
}

export interface KeenonLocation {
  floor: string | null
  building: string | null
  x: number
  y: number
  heading_rad: number | null
  reported_at: string | null
  /** 1 while riding an elevator. */
  take_elevator: number | null
}

/** Parse `/custom/robot/location` data: coordinate is "x,y,heading" (heading may be "null"). */
export function parseKeenonLocation(data: unknown): KeenonLocation | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const [x, y, heading] = String(d.coordinate ?? '')
    .split(',')
    .map((part) => (part.trim() === '' || part.trim() === 'null' ? NaN : Number(part)))
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const ts = Number(d.lastReportTimestamp)
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
  return {
    floor: text(d.floor),
    building: text(d.building),
    x,
    y,
    heading_rad: Number.isFinite(heading) ? heading : null,
    reported_at: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
    take_elevator: typeof d.takeElevatorStatus === 'number' ? d.takeElevatorStatus : null,
  }
}

export async function getRobotLocation(client: KeenonClient, robotSn: string): Promise<KeenonLocation | null> {
  return parseKeenonLocation(await client.get<unknown>('/api/open/custom/robot/location', { robotSn }))
}
