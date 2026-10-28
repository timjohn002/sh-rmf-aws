import { z } from 'zod'
import type {
  SecretState,
  VendorConfigView,
  VendorEventSummary,
  VendorStore,
  VendorSummary,
  VendorSyncResult,
} from '../../src/types/api'
import { HttpError, handler, json, methodNotAllowed, parseBody, requireAdmin } from '../lib/http'
import { db } from '../lib/supabaseAdmin'
import { VendorApiError } from '../vendors/errors'
import { VENDORS, getAdapter } from '../vendors/index'
import {
  contextFor,
  ensureConfig,
  loadConfig,
  newWebhookToken,
  persistSync,
  updateConfig,
  vendorStatus,
  webhookUrl,
} from '../vendors/store'
import type { VendorAdapter, VendorConfigRow } from '../vendors/types'

const EVENT_SUMMARY_COLUMNS = 'id, vendor, received_at, event_type, robot_external_id, signature, status, error'

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string().max(500)).optional(),
})

async function robotCounts(): Promise<Map<string, number>> {
  const { data, error } = await db().from('robots').select('vendor')
  if (error) throw error
  const counts = new Map<string, number>()
  for (const { vendor } of data as { vendor: string }[]) counts.set(vendor, (counts.get(vendor) ?? 0) + 1)
  return counts
}

function maskSecrets(adapter: VendorAdapter, config: VendorConfigRow): Record<string, SecretState> {
  return Object.fromEntries(
    adapter.secretFields.map((field) => {
      const value = config.secrets[field]
      return [field, { set: !!value, last4: value ? value.slice(-4) : null }]
    }),
  )
}

async function configView(adapter: VendorAdapter, config: VendorConfigRow, req: Request): Promise<VendorConfigView> {
  const { data: stores, error } = await db()
    .from('vendor_stores')
    .select('external_id, name, brand, address, country, synced_at')
    .eq('vendor', adapter.id)
    .order('name')
  if (error) throw error
  return {
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    status: vendorStatus(adapter, config),
    enabled: config.enabled,
    settings: adapter.settingsSchema.parse(config.settings),
    secrets: maskSecrets(adapter, config),
    webhook_url: webhookUrl(adapter.id, config.webhook_token, req),
    token_expires_at: config.token_expires_at,
    last_sync_at: config.last_sync_at,
    last_sync_error: config.last_sync_error,
    last_callback_at: config.last_callback_at,
    stores: stores as VendorStore[],
    robot_count: (await robotCounts()).get(adapter.id) ?? 0,
  }
}

async function listVendors(): Promise<Response> {
  const { data, error } = await db().from('vendor_configs').select('*')
  if (error) throw error
  const configs = new Map((data as VendorConfigRow[]).map((c) => [c.vendor, c]))
  const counts = await robotCounts()
  const list: VendorSummary[] = VENDORS.map((adapter) => {
    const config = configs.get(adapter.id) ?? null
    return {
      id: adapter.id,
      name: adapter.name,
      description: adapter.description,
      status: vendorStatus(adapter, config),
      enabled: config?.enabled ?? false,
      robot_count: counts.get(adapter.id) ?? 0,
      last_sync_at: config?.last_sync_at ?? null,
      last_callback_at: config?.last_callback_at ?? null,
    }
  })
  return json(list)
}

async function updateVendor(adapter: VendorAdapter, req: Request): Promise<Response> {
  const input = await parseBody(req, updateSchema)
  const config = await ensureConfig(adapter.id)

  const parsed = adapter.settingsSchema.safeParse({ ...config.settings, ...input.settings })
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid settings')
  const settings = parsed.data

  const newSecrets = Object.fromEntries(
    Object.entries(input.secrets ?? {}).filter(([k, v]) => adapter.secretFields.includes(k) && v.trim() !== ''),
  )
  const credentialsChanged =
    Object.keys(newSecrets).length > 0 ||
    adapter.credentialSettings.some((key) => JSON.stringify(settings[key]) !== JSON.stringify(config.settings[key]))

  const updated = await updateConfig(adapter.id, {
    settings,
    secrets: { ...config.secrets, ...Object.fromEntries(Object.entries(newSecrets).map(([k, v]) => [k, v.trim()])) },
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    // New credentials invalidate the cached token and the last sync error.
    ...(credentialsChanged ? { access_token: null, token_expires_at: null, last_sync_error: null } : {}),
  })
  return json(await configView(adapter, updated, req))
}

async function requireConfigured(adapter: VendorAdapter): Promise<VendorConfigRow> {
  const config = await loadConfig(adapter.id)
  if (!config || !adapter.isConfigured(config)) {
    throw new HttpError(400, `${adapter.name} is not configured yet. Save the connection settings first.`)
  }
  return config
}

/** Turn vendor API failures into a 502 with the vendor's (admin-safe) message. */
async function callVendor<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof VendorApiError) throw new HttpError(502, err.message)
    throw err
  }
}

async function testVendor(adapter: VendorAdapter): Promise<Response> {
  const config = await requireConfigured(adapter)
  return json(await callVendor(() => adapter.testConnection(contextFor(config))))
}

async function syncVendor(adapter: VendorAdapter): Promise<Response> {
  const config = await requireConfigured(adapter)
  try {
    const data = await callVendor(() => adapter.fetchSyncData(contextFor(config)))
    await persistSync(adapter.id, data)
    await updateConfig(adapter.id, { last_sync_at: new Date().toISOString(), last_sync_error: null })
    const result: VendorSyncResult = { stores: data.stores.length, robots: data.robots.length }
    return json(result)
  } catch (err) {
    if (err instanceof HttpError) await updateConfig(adapter.id, { last_sync_error: err.message })
    throw err
  }
}

async function listEvents(adapter: VendorAdapter, req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams
  let query = db()
    .from('vendor_events')
    .select(EVENT_SUMMARY_COLUMNS)
    .eq('vendor', adapter.id)
    .order('received_at', { ascending: false })
    .limit(Math.min(Number(params.get('limit')) || 50, 200))
  const type = params.get('type')
  const status = params.get('status')
  const before = params.get('before')
  if (type) query = query.eq('event_type', type)
  if (status) query = query.eq('status', status)
  if (before && !Number.isNaN(Date.parse(before))) query = query.lt('received_at', before)
  const { data, error } = await query
  if (error) throw error
  return json(data as VendorEventSummary[])
}

async function getEvent(id: string): Promise<Response> {
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'Event not found')
  const { data, error } = await db().from('vendor_events').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Event not found')
  return json(data)
}

export default handler(async (req) => {
  await requireAdmin(req)
  // /api/vendors[/<vendor>[/<action>]] and /api/vendor-events/<id>; parsed by hand so one handler serves every shape.
  const [, section, vendorId, action, ...rest] = new URL(req.url).pathname.split('/').filter(Boolean)
  if (rest.length) throw new HttpError(404, 'Not found')

  if (section === 'vendor-events') {
    if (req.method !== 'GET' || action) methodNotAllowed()
    return getEvent(vendorId ?? '')
  }

  if (!vendorId) {
    if (req.method !== 'GET') methodNotAllowed()
    return listVendors()
  }

  const adapter = getAdapter(vendorId)
  switch (action) {
    case undefined:
      if (req.method === 'GET') return json(await configView(adapter, await ensureConfig(adapter.id), req))
      if (req.method === 'PUT') return updateVendor(adapter, req)
      methodNotAllowed()
    case 'test':
      if (req.method !== 'POST') methodNotAllowed()
      return testVendor(adapter)
    case 'sync':
      if (req.method !== 'POST') methodNotAllowed()
      return syncVendor(adapter)
    case 'rotate-webhook': {
      if (req.method !== 'POST') methodNotAllowed()
      await ensureConfig(adapter.id)
      const updated = await updateConfig(adapter.id, { webhook_token: newWebhookToken() })
      return json(await configView(adapter, updated, req))
    }
    case 'events':
      if (req.method !== 'GET') methodNotAllowed()
      return listEvents(adapter, req)
    default:
      throw new HttpError(404, 'Not found')
  }
})
