// Persistence shared by all vendors: configs, stores, robots and the event log.

import { randomBytes } from 'node:crypto'
import type { VendorStatus, WorkState } from '../../src/types/api'
import { db } from '../lib/supabaseAdmin'
import { resolveWorkState } from './robotState'
import type { RobotPatch, SyncData, SyncedRobot, VendorAdapter, VendorConfigRow, VendorContext } from './types'

export const EVENT_RETENTION_DAYS = 30
const MAX_STORED_BODY = 256 * 1024

export function newWebhookToken(): string {
  return randomBytes(24).toString('base64url')
}

export async function loadConfig(vendor: string): Promise<VendorConfigRow | null> {
  const { data, error } = await db().from('vendor_configs').select('*').eq('vendor', vendor).maybeSingle()
  if (error) throw error
  return data as VendorConfigRow | null
}

/** Load the vendor's config, creating an empty (disabled) one the first time. */
export async function ensureConfig(vendor: string): Promise<VendorConfigRow> {
  const existing = await loadConfig(vendor)
  if (existing) return existing
  const { data, error } = await db()
    .from('vendor_configs')
    .upsert({ vendor, webhook_token: newWebhookToken() }, { onConflict: 'vendor', ignoreDuplicates: true })
    .select('*')
    .maybeSingle()
  if (error) throw error
  return (data as VendorConfigRow | null) ?? (await loadConfig(vendor))!
}

export async function updateConfig(vendor: string, patch: Partial<VendorConfigRow>): Promise<VendorConfigRow> {
  const { data, error } = await db().from('vendor_configs').update(patch).eq('vendor', vendor).select('*').single()
  if (error) throw error
  return data as VendorConfigRow
}

export function contextFor(config: VendorConfigRow): VendorContext {
  return {
    config,
    async saveToken(token, expiresAt) {
      config.access_token = token
      config.token_expires_at = expiresAt.toISOString()
      const { error } = await db()
        .from('vendor_configs')
        .update({ access_token: token, token_expires_at: config.token_expires_at })
        .eq('vendor', config.vendor)
      if (error) throw error
    },
  }
}

export function vendorStatus(adapter: VendorAdapter, config: VendorConfigRow | null): VendorStatus {
  if (!config || !adapter.isConfigured(config)) return 'not_configured'
  if (!config.enabled) return 'disabled'
  if (config.last_sync_error) return 'error'
  return 'connected'
}

/** Public URL vendors should call. `PUBLIC_SITE_URL` wins so local dev shows the live URL. */
export function webhookUrl(vendor: string, token: string, req: Request): string {
  const base = (process.env.PUBLIC_SITE_URL || new URL(req.url).origin).replace(/\/+$/, '')
  return `${base}/api/vendors/${vendor}/webhook/${token}`
}

export async function persistSync(vendor: string, data: SyncData): Promise<void> {
  const now = new Date().toISOString()
  if (data.stores.length) {
    const { error } = await db()
      .from('vendor_stores')
      .upsert(
        data.stores.map((s) => ({ ...s, vendor, synced_at: now })),
        { onConflict: 'vendor,external_id' },
      )
    if (error) throw error
  }
  await persistRobots(vendor, data.robots)
}

/**
 * Save robot updates, keeping the work-state badge consistent with online status
 * (see resolveWorkState). Used by sync, refresh and callbacks.
 */
export async function persistRobots(
  vendor: string,
  robots: SyncedRobot[],
  extra: { last_seen_at?: string; last_refreshed_at?: string } = {},
): Promise<void> {
  if (!robots.length) return
  const { data, error } = await db()
    .from('robots')
    .select('external_id, work_state')
    .eq('vendor', vendor)
    .in('external_id', robots.map((r) => r.external_id))
  if (error) throw error
  const previous = new Map((data as { external_id: string; work_state: WorkState }[]).map((r) => [r.external_id, r.work_state]))

  // One upsert per robot: rows carry different field sets, and a batch upsert
  // would null out the fields a row doesn't mention.
  for (const { external_id, ...patch } of robots) {
    const workState = resolveWorkState(previous.get(external_id), patch)
    await applyRobotPatch(vendor, external_id, workState ? { ...patch, work_state: workState } : patch, extra)
  }
}

/** Create the robot if new, then set only the given fields. */
export async function applyRobotPatch(
  vendor: string,
  externalId: string,
  patch: RobotPatch,
  extra: { last_seen_at?: string; last_refreshed_at?: string } = {},
): Promise<void> {
  const { error } = await db()
    .from('robots')
    .upsert({ vendor, external_id: externalId, ...patch, ...extra }, { onConflict: 'vendor,external_id' })
  if (error) throw error
}

const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'x-api-key'])

export function headersForLog(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    const name = key.toLowerCase()
    out[key] = REDACTED_HEADERS.has(name) ? '[redacted]' : value
  })
  return out
}

export interface EventRecord {
  vendor: string
  event_type: string
  robot_external_id: string | null
  signature: string
  signature_detail?: string | null
  headers: Record<string, string>
  rawBody: string
  parsedBody: unknown
  status: 'processed' | 'ignored' | 'rejected' | 'failed'
  error?: string | null
  duration_ms: number
}

export async function recordEvent(event: EventRecord): Promise<void> {
  const { rawBody, parsedBody, ...rest } = event
  const tooBig = rawBody.length > MAX_STORED_BODY
  const { error } = await db()
    .from('vendor_events')
    .insert({
      ...rest,
      body: !tooBig && parsedBody !== undefined ? parsedBody : null,
      body_text: tooBig ? rawBody.slice(0, MAX_STORED_BODY) : parsedBody === undefined ? rawBody : null,
    })
  if (error) throw error
}
