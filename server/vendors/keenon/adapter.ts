import { z } from 'zod'
import { KEENON_SECRET_FIELDS, keenonBaseUrl, type KeenonSettings } from '../../../src/vendors/keenon/shared'
import type { SyncedRobot, VendorAdapter, VendorConfigRow, VendorContext } from '../types'
import { getRobots, getStores } from './api'
import { KeenonClient, KeenonError } from './client'
import { KEENON_OK, KEENON_ONLINE_TYPE, type KeenonRobot } from './types'
import { locateKeenonRobots, prepareKeenonPlacer } from './placement'
import { interpretKeenonCallback, verifyKeenonSignature } from './webhook'

const settingsSchema = z.object({
  region: z.enum(['global', 'cn', 'eu', 'jp', 'custom']).default('global'),
  custom_base_url: z
    .string()
    .trim()
    .max(300)
    .default('')
    .refine((v) => v === '' || /^https?:\/\/\S+$/.test(v), 'Custom URL must start with http:// or https://'),
  client_id: z.string().trim().max(200).default(''),
  require_signature: z.boolean().default(false),
  store_ids: z.array(z.string().max(100)).max(500).default([]),
})

function settingsOf(config: VendorConfigRow): KeenonSettings {
  return settingsSchema.parse(config.settings)
}

/** Keenon API client for the saved configuration (shares the cached token). */
export function keenonClientFor(ctx: VendorContext): KeenonClient {
  const settings = settingsOf(ctx.config)
  const baseUrl = keenonBaseUrl(settings)
  const clientSecret = ctx.config.secrets.client_secret
  if (!baseUrl || !settings.client_id || !clientSecret) {
    throw new KeenonError(null, 'Keenon is not fully configured: set the region, client ID and client secret.')
  }
  const { access_token, token_expires_at } = ctx.config
  return new KeenonClient({
    baseUrl,
    clientId: settings.client_id,
    clientSecret,
    cachedToken:
      access_token && token_expires_at ? { token: access_token, expiresAt: new Date(token_expires_at) } : null,
    saveToken: ctx.saveToken,
  })
}

/** Keenon sends onlineStatus as 1/0 (robot list) or true/false (other APIs). */
export function keenonOnline(value: unknown): boolean | null {
  if (value === 1 || value === true || value === '1' || value === 'true') return true
  if (value === 0 || value === false || value === '0' || value === 'false') return false
  return null
}

/** Map one robot-list entry (`store/robot/list`) to our robot fields. */
export function keenonRobotFromList(r: KeenonRobot, storeId: string): SyncedRobot {
  return {
    external_id: r.robotId,
    store_external_id: storeId,
    name: r.robotName ?? null,
    model: r.robotModel ?? null,
    app_version: r.appVersion ?? null,
    online: keenonOnline(r.onlineStatus),
    online_type: r.onlineType !== undefined ? (KEENON_ONLINE_TYPE[r.onlineType] ?? String(r.onlineType)) : null,
    battery: typeof r.power === 'number' ? r.power : null,
  }
}

/**
 * Robots of the given stores via `/api/open/data/v1/store/robot/list` — the source of truth
 * for online status (the scene status API disagrees for some robots, e.g. cleaning robots).
 */
export async function fetchStoreRobots(client: KeenonClient, storeIds: string[]): Promise<SyncedRobot[]> {
  const robots: SyncedRobot[] = []
  // Sequential on purpose: Keenon rate-limits by client and IP.
  for (const storeId of storeIds) {
    for (const r of await getRobots(client, storeId)) {
      if (r.robotId) robots.push(keenonRobotFromList(r, storeId))
    }
  }
  return robots
}

export const keenonAdapter: VendorAdapter = {
  id: 'keenon',
  name: 'Keenon',
  description: 'Delivery, hotel and cleaning robots via Keenon Cloud (Open Platform API).',
  settingsSchema,
  secretFields: KEENON_SECRET_FIELDS,
  credentialSettings: ['region', 'custom_base_url', 'client_id'],
  // Keenon disables IPs/clients that query too often (610609 / 617000).
  robotCapabilities: { refresh: true, refreshCooldownMs: 10_000 },
  mapPositions: {
    // The Map page polls every 5 s; Keenon recommends at least ~3 s between status queries.
    refreshAfterMs: 4_000,
    prepare: prepareKeenonPlacer,
    locate: (ctx, robots) => locateKeenonRobots(keenonClientFor(ctx), robots),
  },

  isConfigured(config) {
    const settings = settingsSchema.safeParse(config.settings)
    return settings.success && !!keenonBaseUrl(settings.data) && !!settings.data.client_id && !!config.secrets.client_secret
  },

  async testConnection(ctx) {
    const client = keenonClientFor(ctx)
    await client.getToken(true)
    const stores = await getStores(client)
    return {
      token_expires_in: client.tokenExpiresIn,
      stores: stores.map((s) => ({ external_id: s.storeId, name: s.storeName ?? null })),
    }
  },

  async fetchSyncData(ctx) {
    const client = keenonClientFor(ctx)
    const { store_ids } = settingsOf(ctx.config)
    const stores = await getStores(client)
    const selected = store_ids.length ? stores.filter((s) => store_ids.includes(s.storeId)) : stores

    const robots = await fetchStoreRobots(
      client,
      selected.map((s) => s.storeId),
    )

    return {
      stores: stores.map((s) => ({
        external_id: s.storeId,
        name: s.storeName ?? null,
        brand: s.brandName ?? null,
        address: s.address ?? null,
        country: s.country ?? null,
      })),
      robots,
    }
  },

  async refreshRobots(ctx) {
    const client = keenonClientFor(ctx)
    const { store_ids } = settingsOf(ctx.config)
    // Selected stores, or every store of the account (one extra call) when none are selected.
    const storeIds = store_ids.length ? store_ids : (await getStores(client)).map((s) => s.storeId)
    return fetchStoreRobots(client, storeIds)
  },

  verifyWebhook(config, rawBody, headers) {
    return verifyKeenonSignature(rawBody, headers, config.secrets.client_secret)
  },

  requireSignature(config) {
    const settings = settingsSchema.safeParse(config.settings)
    return settings.success && settings.data.require_signature
  },

  interpretWebhook: (body) => interpretKeenonCallback(body),

  webhookAck: { code: KEENON_OK, msg: 'success' },
}
