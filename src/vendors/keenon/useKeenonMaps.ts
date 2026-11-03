import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { RobotPosition } from '../../types/api'
import type { AlignmentSample } from './alignment'
import type { CalibrationPair } from './calibration'
import type {
  KeenonRobotFloor,
  KeenonRobotMapSummary,
  KeenonRobotMapsDetail,
  KeenonScene,
  KeenonTaskFloors,
  KeenonTaskPoints,
  KeenonTaskSent,
} from './shared'

const ROBOTS_KEY = ['keenon-maps', 'robots']
const detailKey = (robotId: string) => ['keenon-maps', 'robot', robotId]

export function useKeenonMapRobots() {
  return useQuery({
    queryKey: ROBOTS_KEY,
    queryFn: () => api<KeenonRobotMapSummary[]>('/api/keenon/robots'),
  })
}

export function useKeenonRobotMaps(robotId: string) {
  return useQuery({
    queryKey: detailKey(robotId),
    queryFn: () => api<KeenonRobotMapsDetail>(`/api/keenon/robots/${robotId}/floors`),
  })
}

/** Mutations returning the robot's full detail refresh both the page and the summary list. */
function useDetailMutation<V>(robotId: string, fn: (vars: V) => Promise<KeenonRobotMapsDetail>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (detail) => queryClient.setQueryData(detailKey(robotId), detail),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ROBOTS_KEY }),
  })
}

export function useDiscoverRobotMaps(robotId: string) {
  return useDetailMutation<void>(robotId, () =>
    api<KeenonRobotMapsDetail>(`/api/keenon/robots/${robotId}/discover`, { method: 'POST' }),
  )
}

export function useSetRobotScene(robotId: string) {
  return useDetailMutation<{ scene_code: string | null; scene_name?: string | null }>(robotId, (body) =>
    api<KeenonRobotMapsDetail>(`/api/keenon/robots/${robotId}/scene`, { method: 'PUT', body }),
  )
}

export function useStoreScenes(storeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['keenon-maps', 'scenes', storeId],
    queryFn: () => api<KeenonScene[]>(`/api/keenon/stores/${encodeURIComponent(storeId!)}/scenes`),
    enabled: enabled && !!storeId,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Replace one floor in the cached robot detail (and refresh the summary list). */
function useFloorMutation<V>(robotId: string, fn: (vars: V) => Promise<KeenonRobotFloor>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (floor) => {
      queryClient.setQueryData<KeenonRobotMapsDetail>(detailKey(robotId), (detail) =>
        detail && { ...detail, floors: detail.floors.map((f) => (f.id === floor.id ? floor : f)) },
      )
      queryClient.invalidateQueries({ queryKey: ROBOTS_KEY })
    },
  })
}

export interface CalibrationInput {
  scale: number
  rotation: number
  origin_x: number
  origin_y: number
  pairs: CalibrationPair[]
}

export function useSaveCalibration(robotId: string) {
  return useFloorMutation<{ floorId: string; calibration: CalibrationInput }>(robotId, ({ floorId, calibration }) =>
    api<KeenonRobotFloor>(`/api/keenon/robot-floors/${floorId}/calibration`, { method: 'PUT', body: calibration }),
  )
}

export function useClearCalibration(robotId: string) {
  return useFloorMutation<string>(robotId, (floorId) =>
    api<KeenonRobotFloor>(`/api/keenon/robot-floors/${floorId}/calibration`, { method: 'DELETE' }),
  )
}

export interface AlignmentInput {
  rotation: number
  offset_x: number
  offset_y: number
  mirror: boolean
  samples: AlignmentSample[]
}

export function useSaveAlignment(robotId: string) {
  return useFloorMutation<{ floorId: string; alignment: AlignmentInput }>(robotId, ({ floorId, alignment }) =>
    api<KeenonRobotFloor>(`/api/keenon/robot-floors/${floorId}/alignment`, { method: 'PUT', body: alignment }),
  )
}

export function useClearAlignment(robotId: string) {
  return useFloorMutation<string>(robotId, (floorId) =>
    api<KeenonRobotFloor>(`/api/keenon/robot-floors/${floorId}/alignment`, { method: 'DELETE' }),
  )
}

/** Ask Keenon where the robot is now (whitelisted network only); updates the cached detail. */
export function useLocateRobot(robotId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<RobotPosition>(`/api/keenon/robots/${robotId}/locate`, { method: 'POST' }),
    onSuccess: (position) =>
      queryClient.setQueryData<KeenonRobotMapsDetail>(detailKey(robotId), (detail) => detail && { ...detail, position }),
  })
}

export function useMatchFloor(robotId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ floorId, appFloorId }: { floorId: string; appFloorId: string | null }) =>
      api<KeenonRobotFloor>(`/api/keenon/robot-floors/${floorId}`, {
        method: 'PUT',
        body: { app_floor_id: appFloorId },
      }),
    onSuccess: (floor) => {
      queryClient.setQueryData<KeenonRobotMapsDetail>(detailKey(robotId), (detail) =>
        detail && { ...detail, floors: detail.floors.map((f) => (f.id === floor.id ? floor : f)) },
      )
      queryClient.invalidateQueries({ queryKey: ROBOTS_KEY })
    },
  })
}

// ---------------------------------------------------------------------------
// Send task (S100): floors, points and the remote call
// ---------------------------------------------------------------------------

/** The robot's floors in its current scene (to pick where to send it). */
export function useTaskFloors(robotId: string) {
  return useQuery({
    queryKey: ['keenon-tasks', robotId, 'floors'],
    queryFn: () => api<KeenonTaskFloors>(`/api/keenon/robots/${robotId}/task-floors`),
  })
}

/** "normal" points on one floor that the robot can be sent to, fetched live from Keenon. */
export function useTaskPoints(robotId: string, floor: number | null) {
  return useQuery({
    queryKey: ['keenon-tasks', robotId, 'points', floor],
    queryFn: () => api<KeenonTaskPoints>(`/api/keenon/robots/${robotId}/task-points?floor=${floor}`),
    enabled: floor !== null,
    staleTime: 60_000,
  })
}

/** Reload a floor's points, also refreshing the scene's cached target list on the server. */
export function useRefreshTaskPoints(robotId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (floor: number) =>
      api<KeenonTaskPoints>(`/api/keenon/robots/${robotId}/task-points?floor=${floor}&refresh=1`),
    onSuccess: (data, floor) => queryClient.setQueryData(['keenon-tasks', robotId, 'points', floor], data),
  })
}

export function useSendTask(robotId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (point: { uuid: string; point_id: string; point_name: string }) =>
      api<KeenonTaskSent>(`/api/keenon/robots/${robotId}/task`, { method: 'POST', body: point }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['robots'] }),
  })
}

export function useCancelTask(robotId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ ok: true; task_no: string }>(`/api/keenon/robots/${robotId}/task-cancel`, { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['robots'] }),
  })
}
