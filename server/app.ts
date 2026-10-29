import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { json } from './lib/http'

type Params = Record<string, string | undefined>

/** An API handler as exported by `server/api/*` (see `handler()` in lib/http.ts). */
export type RouteHandler = (req: Request, context: { params?: Params }) => Promise<Response>

export interface Route {
  paths: string[]
  handler: RouteHandler
}

export interface AppOptions {
  routes: Route[]
  /** Built web app (`dist/`). Omitted or missing in dev, where Vite serves it. */
  staticDir?: string
  /** Readiness check for /readyz; throw when a dependency is unavailable. */
  ready?: () => Promise<void>
  /** One JSON log line per API request. */
  log?: boolean
}

export function logJson(level: 'info' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })
  if (level === 'error') console.error(line)
  else console.log(line)
}

/** Webhook URLs carry a secret token; keep it out of the logs. */
export function pathForLog(path: string): string {
  return path.replace(/(\/webhook\/)[^/]+/, '$1[redacted]')
}

/**
 * Behind a TLS-terminating proxy (the AWS load balancer), the request arrives as
 * plain http on the pod's port. Rebuild the URL from X-Forwarded-Proto/Host so
 * handlers see the public origin: it decides the Secure cookie flag, the origin
 * check and the webhook URL. Only use when a trusted proxy sets these headers.
 */
export function applyForwardedHeaders(req: Request): Request {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  if (!proto && !host) return req

  const original = new URL(req.url)
  const scheme = proto === 'http' || proto === 'https' ? proto : original.protocol.slice(0, -1)
  // Build a fresh URL: assigning url.host keeps the pod's port when the public host has none.
  const url = new URL(original.pathname + original.search, `${scheme}://${host || original.host}`)
  if (url.href === req.url) return req

  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: req.signal,
    duplex: 'half',
  } as RequestInit)
}

export function createApp({ routes, staticDir, ready, log = true }: AppOptions): Hono {
  const app = new Hono()

  app.get('/healthz', (c) => c.text('ok'))
  app.get('/readyz', async (c) => {
    try {
      await ready?.()
      return c.text('ok')
    } catch (err) {
      logJson('error', 'readiness check failed', { error: err instanceof Error ? err.message : String(err) })
      return c.text('not ready', 503)
    }
  })

  if (log) {
    app.use('/api/*', async (c, next) => {
      const start = performance.now()
      await next()
      logJson('info', 'request', {
        method: c.req.method,
        path: pathForLog(c.req.path),
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      })
    })
  }

  for (const { paths, handler } of routes) {
    for (const path of paths) {
      app.all(path, (c) => handler(c.req.raw, { params: c.req.param() }))
    }
  }
  app.all('/api/*', () => json({ error: 'Not found' }, { status: 404 }))

  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    const indexHtml = readFileSync(join(staticDir, 'index.html'), 'utf8')
    app.use('*', async (c, next) => {
      await next()
      // Vite puts content-hashed files in assets/; everything else may change between deploys.
      if (c.res.ok && !c.res.headers.has('cache-control')) {
        const immutable = c.req.path.startsWith('/assets/')
        c.res.headers.set('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      }
    })
    app.use('*', serveStatic({ root: staticDir }))
    // Single-page app: unknown paths get index.html so React Router can handle them,
    // but a missing asset is a real 404 rather than HTML served as JavaScript.
    app.get('*', (c) => {
      if (c.req.path.startsWith('/assets/')) return c.text('Not found', 404)
      c.header('cache-control', 'no-cache')
      return c.html(indexHtml)
    })
  }

  return app
}
