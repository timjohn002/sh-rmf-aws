import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { applyForwardedHeaders, createApp, logJson } from './app'
import { db } from './lib/supabaseAdmin'
import { syncLiftMind } from './elevators/store'
import { ROUTES } from './routes'
import { VENDORS } from './vendors/index'
import { getConfigCached } from './vendors/store'

const port = Number(process.env.PORT ?? 8080)
const trustProxy = process.env.TRUST_PROXY === 'true'
// dist-server/main.mjs (built) and server/main.ts (dev) both sit one level below the project root.
const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

/** Ready when the database answers a trivial query. */
async function ready() {
  const { error } = await db().from('app_users').select('id').limit(1)
  if (error) throw new Error(error.message)
}

const app = createApp({ routes: ROUTES, staticDir, ready })

// Load vendor configs now, so even the first callback is answered without waiting on the database.
for (const vendor of VENDORS) getConfigCached(vendor.id).catch(() => {})
// Connect to LiftMind (elevators) if it's set up; problems show on the Elevators page. Re-check
// the saved settings every 30 s, so Connect/Disconnect pressed on another copy of the app (sharing
// the database) applies here too. Only a real change reconnects.
void syncLiftMind()
setInterval(() => void syncLiftMind(), 30_000).unref()

const server = serve(
  { fetch: (req) => app.fetch(trustProxy ? applyForwardedHeaders(req) : req), port },
  (info) => logJson('info', 'listening', { port: info.port, trustProxy, staticDir }),
)

function shutdown(signal: string) {
  logJson('info', 'shutting down', { signal })
  server.close(() => process.exit(0))
  // Don't wait forever on long-lived connections.
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
