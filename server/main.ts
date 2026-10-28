import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { applyForwardedHeaders, createApp, logJson } from './app'
import { db } from './lib/supabaseAdmin'
import { ROUTES } from './routes'

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
