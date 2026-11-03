import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type {
  Elevator,
  ElevatorCheckResult,
  ElevatorImportResult,
  ElevatorInput,
  ElevatorsLive,
  ElevatorsResponse,
  LiftMindConnectionUpdate,
  TestRide,
  TestRideAction,
  TestRideStart,
} from '../types/api'

const ELEVATORS_KEY = ['elevators']
const LIVE_KEY = ['elevators', 'live']

/** LiftMind connection settings and all lifts. */
export function useElevators() {
  return useQuery({ queryKey: ELEVATORS_KEY, queryFn: () => api<ElevatorsResponse>('/api/elevators') })
}

/** Connection status, the test ride and recent MQTT messages: every second during a ride, else every 3 s. */
export function useElevatorsLive() {
  return useQuery({
    queryKey: LIVE_KEY,
    queryFn: () => api<ElevatorsLive>('/api/elevators/live'),
    refetchInterval: (query) => {
      const ride = query.state.data?.ride
      return ride && !['done', 'rejected', 'aborted', 'cancelled'].includes(ride.stage) ? 1_000 : 3_000
    },
  })
}

function useInvalidating<V, R>(fn: (vars: V) => Promise<R>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ELEVATORS_KEY }),
  })
}

export function useSaveConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (update: LiftMindConnectionUpdate) =>
      api<ElevatorsResponse>('/api/elevators/connection', { method: 'PUT', body: update }),
    onSuccess: (data) => queryClient.setQueryData(ELEVATORS_KEY, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: LIVE_KEY }),
  })
}

export function useImportSettings() {
  return useInvalidating((settings: unknown) =>
    api<ElevatorImportResult>('/api/elevators/import', { method: 'POST', body: settings }),
  )
}

export function useSaveElevator() {
  return useInvalidating(({ id, input }: { id: string | null; input: ElevatorInput }) =>
    id
      ? api<Elevator>(`/api/elevators/${id}`, { method: 'PATCH', body: input })
      : api<Elevator>('/api/elevators', { method: 'POST', body: input }),
  )
}

export function useDeleteElevator() {
  return useInvalidating((id: string) => api<{ ok: true }>(`/api/elevators/${id}`, { method: 'DELETE' }))
}

export function useCheckElevator() {
  return useMutation({
    mutationFn: (id: string) => api<ElevatorCheckResult>(`/api/elevators/${id}/check`, { method: 'POST' }),
  })
}

function useLiveMutation<V>(fn: (vars: V) => Promise<{ ride: TestRide | null }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: LIVE_KEY }),
  })
}

export function useStartTestRide() {
  return useLiveMutation(({ id, input }: { id: string; input: TestRideStart }) =>
    api<{ ride: TestRide }>(`/api/elevators/${id}/test-ride`, { method: 'POST', body: input }),
  )
}

export function useTestRideAction() {
  return useLiveMutation(({ action, ...body }: TestRideAction) =>
    api<{ ride: TestRide | null }>(`/api/elevators/test-ride/${action}`, { method: 'POST', body }),
  )
}
