import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type {
  VendorConfigView,
  VendorEvent,
  VendorEventSummary,
  VendorSummary,
  VendorSyncResult,
  VendorTestResult,
  VendorUpdate,
} from '../types/api'

const VENDORS_KEY = ['vendors']

export function useVendors() {
  return useQuery({ queryKey: VENDORS_KEY, queryFn: () => api<VendorSummary[]>('/api/vendors') })
}

export function useVendorConfig<S>(id: string) {
  return useQuery({
    queryKey: [...VENDORS_KEY, id],
    queryFn: () => api<VendorConfigView<S>>(`/api/vendors/${id}`),
  })
}

/** Mutations that return the updated config keep the cache in sync. */
function useConfigMutation<S, V>(id: string, fn: (vars: V) => Promise<VendorConfigView<S>>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (config) => {
      queryClient.setQueryData([...VENDORS_KEY, id], config)
      queryClient.invalidateQueries({ queryKey: VENDORS_KEY, exact: true })
    },
  })
}

export function useUpdateVendor<S>(id: string) {
  return useConfigMutation<S, VendorUpdate<S>>(id, (update) =>
    api<VendorConfigView<S>>(`/api/vendors/${id}`, { method: 'PUT', body: update }),
  )
}

export function useRotateWebhook<S>(id: string) {
  return useConfigMutation<S, void>(id, () =>
    api<VendorConfigView<S>>(`/api/vendors/${id}/rotate-webhook`, { method: 'POST' }),
  )
}

export function useTestVendor(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<VendorTestResult>(`/api/vendors/${id}/test`, { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: VENDORS_KEY }),
  })
}

export function useSyncVendor(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<VendorSyncResult>(`/api/vendors/${id}/sync`, { method: 'POST' }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: VENDORS_KEY })
      queryClient.invalidateQueries({ queryKey: ['robots'] })
    },
  })
}

export interface EventFilters {
  status?: string
  type?: string
}

export function useVendorEvents(id: string, filters: EventFilters, before?: string) {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.type) params.set('type', filters.type)
  if (before) params.set('before', before)
  return useQuery({
    queryKey: ['vendor-events', id, filters, before ?? null],
    queryFn: () => api<VendorEventSummary[]>(`/api/vendors/${id}/events?${params}`),
    refetchInterval: before ? false : 10_000,
    placeholderData: keepPreviousData,
  })
}

/** The newest callbacks with their bodies, polled while `enabled` (Live callbacks). */
export function useLiveVendorEvents(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['vendor-events', id, 'live'],
    queryFn: () => api<VendorEvent[]>(`/api/vendors/${id}/events?full=1&limit=20`),
    refetchInterval: enabled ? 3_000 : false,
    enabled,
    placeholderData: keepPreviousData,
  })
}

export function useVendorEvent(eventId: string | null) {
  return useQuery({
    queryKey: ['vendor-event', eventId],
    queryFn: () => api<VendorEvent>(`/api/vendor-events/${eventId}`),
    enabled: !!eventId,
  })
}
