import { refreshWaitSeconds } from '../../src/lib/robotRefresh'
import type { Robot, RobotVendorInfo, RobotsResponse } from '../../src/types/api'
import { HttpError, handler, json, methodNotAllowed, requireUser } from '../lib/http'
import { db } from '../lib/supabaseAdmin'
import { VendorApiError } from '../vendors/errors'
import { findAdapter, getAdapter } from '../vendors/index'
import { groupRobots, unknownVendorInfo } from '../vendors/robotGroups'
import { contextFor, loadConfig, persistRobots, vendorStatus } from '../vendors/store'
import type { VendorConfigRow } from '../vendors/types'

type RobotRow = Omit<Robot, 'store_name'>

async function storeNames(): Promise<Map<string, string | null>> {
  const { data, error } = await db().from('vendor_stores').select('vendor, external_id, name')
  if (error) throw error
  return new Map(
    (data as { vendor: string; external_id: string; name: string | null }[]).map((s) => [
      `${s.vendor}:${s.external_id}`,
      s.name,
    ]),
  )
}

function withStore(row: RobotRow, names: Map<string, string | null>): Robot {
  return { ...row, store_name: row.store_external_id ? (names.get(`${row.vendor}:${row.store_external_id}`) ?? null) : null }
}

async function listRobots(): Promise<Response> {
  const { data, error } = await db().from('robots').select('*')
  if (error) throw error
  const { data: configRows, error: configError } = await db().from('vendor_configs').select('*')
  if (configError) throw configError
  const configs = new Map((configRows as VendorConfigRow[]).map((c) => [c.vendor, c]))
  const names = await storeNames()

  // Vendor names, status and capabilities come from each vendor's adapter.
  const vendorInfo = (vendorId: string): RobotVendorInfo => {
    const adapter = findAdapter(vendorId)
    if (!adapter) return unknownVendorInfo(vendorId)
    return {
      id: adapter.id,
      name: adapter.name,
      status: vendorStatus(adapter, configs.get(adapter.id) ?? null),
      capabilities: {
        refresh: adapter.robotCapabilities.refresh,
        refresh_cooldown_ms: adapter.robotCapabilities.refreshCooldownMs,
      },
      last_refreshed_at: null, // filled in by groupRobots
    }
  }

  const body: RobotsResponse = {
    groups: groupRobots(
      (data as RobotRow[]).map((r) => withStore(r, names)),
      vendorInfo,
    ),
  }
  return json(body)
}

/** Refresh the status of all of one vendor's robots from the vendor's cloud. */
async function refreshVendor(vendorId: string): Promise<Response> {
  const adapter = getAdapter(vendorId)
  if (!adapter.robotCapabilities.refresh) throw new HttpError(400, `Refresh isn't supported for ${adapter.name}.`)

  // Cooldown is per vendor: measured from the newest refresh of any of its robots.
  const { data: last, error } = await db()
    .from('robots')
    .select('last_refreshed_at')
    .eq('vendor', adapter.id)
    .not('last_refreshed_at', 'is', null)
    .order('last_refreshed_at', { ascending: false })
    .limit(1)
  if (error) throw error
  const wait = refreshWaitSeconds(last?.[0]?.last_refreshed_at ?? null, adapter.robotCapabilities.refreshCooldownMs)
  if (wait > 0) throw new HttpError(429, `Refreshed recently. Try again in ${wait} s.`)

  const config = await loadConfig(adapter.id)
  if (!config || !adapter.isConfigured(config)) {
    throw new HttpError(400, `The ${adapter.name} integration is not configured.`)
  }

  let robots
  try {
    robots = await adapter.refreshRobots(contextFor(config))
  } catch (err) {
    if (err instanceof VendorApiError) throw new HttpError(502, err.message)
    throw err
  }
  await persistRobots(adapter.id, robots, { last_refreshed_at: new Date().toISOString() })
  return json({ robots: robots.length })
}

export default handler(async (req) => {
  await requireUser(req)
  // /api/robots[/vendors/<vendor>/refresh]; parsed by hand so one handler serves every shape.
  const [, , section, vendorId, action, ...rest] = new URL(req.url).pathname.split('/').filter(Boolean)
  if (!section) {
    if (req.method !== 'GET') methodNotAllowed()
    return listRobots()
  }
  if (section !== 'vendors' || !vendorId || action !== 'refresh' || rest.length) {
    throw new HttpError(404, 'Not found')
  }
  if (req.method !== 'POST') methodNotAllowed()
  return refreshVendor(vendorId)
})
