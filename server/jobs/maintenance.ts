import { db } from '../lib/supabaseAdmin'
import { VENDORS } from '../vendors/index'
import { EVENT_RETENTION_DAYS, contextFor, loadConfig, persistSync, updateConfig } from '../vendors/store'

/**
 * Hourly housekeeping, run as a Kubernetes CronJob (`node dist-server/maintenance.mjs`):
 *  - delete vendor events older than the retention period;
 *  - re-sync stores/robots for vendors whose `<VENDOR>_SCHEDULED_SYNC=true`.
 *    Off by default: e.g. Keenon only accepts whitelisted IPs, so enable it only
 *    once the cluster's outbound IP is whitelisted.
 *
 * Exits non-zero if any step failed, so the CronJob shows the failure.
 */
async function runMaintenance(): Promise<boolean> {
  let ok = true
  const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString()
  const { error } = await db().from('vendor_events').delete().lt('received_at', cutoff)
  if (error) {
    console.error('Event cleanup failed', error)
    ok = false
  }

  for (const adapter of VENDORS) {
    if (process.env[`${adapter.id.toUpperCase()}_SCHEDULED_SYNC`] !== 'true') continue
    const config = await loadConfig(adapter.id)
    if (!config?.enabled || !adapter.isConfigured(config)) continue
    try {
      await persistSync(adapter.id, await adapter.fetchSyncData(contextFor(config)))
      await updateConfig(adapter.id, { last_sync_at: new Date().toISOString(), last_sync_error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`${adapter.id} scheduled sync failed: ${message}`)
      await updateConfig(adapter.id, { last_sync_error: message })
      ok = false
    }
  }
  return ok
}

try {
  process.exitCode = (await runMaintenance()) ? 0 : 1
} catch (err) {
  console.error('Maintenance failed', err)
  process.exitCode = 1
}
