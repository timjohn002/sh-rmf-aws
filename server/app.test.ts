import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import auth from './api/auth'
import floors from './api/floors'
import keenonMaps from './api/keenon-maps'
import map from './api/map'
import robots from './api/robots'
import users from './api/users'
import vendorWebhook from './api/vendor-webhook'
import vendors from './api/vendors'
import { type Route, type RouteHandler, applyForwardedHeaders, createApp, pathForLog } from './app'
import { ROUTES } from './routes'

/** The real route table, with each handler swapped for one that reports which route matched. */
function echoRoutes(): Route[] {
  return ROUTES.map((route, index) => ({
    paths: route.paths,
    handler: async (req, { params }) => Response.json({ index, method: req.method, params }),
  }))
}

describe('route table', () => {
  const app = createApp({ routes: echoRoutes(), log: false })

  const cases: [method: string, path: string, handler: RouteHandler, params: Record<string, string>][] = [
    ['POST', '/api/auth/login', auth, { action: 'login' }],
    ['GET', '/api/users', users, {}],
    ['DELETE', '/api/users/u1', users, { id: 'u1' }],
    ['POST', '/api/users/u1/password', users, { id: 'u1' }],
    ['GET', '/api/floors', floors, {}],
    ['PATCH', '/api/floors/f1', floors, { id: 'f1' }],
    ['POST', '/api/floors/f1/plan-upload-url', floors, { id: 'f1' }],
    ['GET', '/api/map/robots', map, {}],
    ['GET', '/api/robots', robots, {}],
    ['POST', '/api/robots/vendors/keenon/refresh', robots, { vendor: 'keenon' }],
    ['POST', '/api/vendors/keenon/webhook/secret-token', vendorWebhook, { vendor: 'keenon', token: 'secret-token' }],
    ['GET', '/api/vendors', vendors, {}],
    ['PUT', '/api/vendors/keenon', vendors, { vendor: 'keenon' }],
    ['POST', '/api/vendors/keenon/sync', vendors, { vendor: 'keenon', action: 'sync' }],
    ['GET', '/api/vendor-events/e1', vendors, { id: 'e1' }],
    ['GET', '/api/keenon/robots', keenonMaps, {}],
    ['POST', '/api/keenon/robots/r1/discover', keenonMaps, { id: 'r1', action: 'discover' }],
    ['GET', '/api/keenon/stores/s1/scenes', keenonMaps, { id: 's1' }],
    ['PATCH', '/api/keenon/robot-floors/kf1', keenonMaps, { id: 'kf1' }],
    ['POST', '/api/keenon/robot-floors/kf1/calibrate', keenonMaps, { id: 'kf1', action: 'calibrate' }],
  ]

  it.each(cases)('%s %s reaches the right handler', async (method, path, handler, params) => {
    const res = await app.request(path, { method })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ index: ROUTES.findIndex((r) => r.handler === handler), method, params })
  })

  it('returns a JSON 404 for unknown API paths', async () => {
    const res = await app.request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('registers every module in server/api', async () => {
    const files = readdirSync(join(__dirname, 'api')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    for (const file of files) {
      const mod = (await import(`./api/${file}`)) as { default: RouteHandler }
      expect(ROUTES.some((r) => r.handler === mod.default), file).toBe(true)
    }
  })
})

describe('health checks', () => {
  it('/healthz is always ok', async () => {
    const res = await createApp({ routes: [], log: false }).request('/healthz')
    expect(res.status).toBe(200)
  })

  it('/readyz reports 503 when the dependency check fails', async () => {
    const failing = async () => {
      throw new Error('db down')
    }
    const res = await createApp({ routes: [], ready: failing, log: false }).request('/readyz')
    expect(res.status).toBe(503)
  })
})

describe('static web app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rmf-static-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Starhub RMF</title>')
  writeFileSync(join(dir, 'assets', 'app-123.js'), 'console.log(1)')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const app = createApp({ routes: echoRoutes(), staticDir: dir, log: false })

  it('serves hashed assets with long-lived caching', async () => {
    const res = await app.request('/assets/app-123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it.each(['/', '/map', '/vendors/keenon/robots/r1'])('serves index.html for %s', async (path) => {
    const res = await app.request(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('Starhub RMF')
  })

  it('404s a missing asset instead of returning index.html', async () => {
    expect((await app.request('/assets/missing.js')).status).toBe(404)
  })

  it('keeps API routes ahead of the web app', async () => {
    expect((await app.request('/api/nope')).status).toBe(404)
  })
})

describe('applyForwardedHeaders', () => {
  it('uses the public scheme and host from the proxy', () => {
    const req = new Request('http://10.0.0.5:8080/api/auth/me', {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'rmf.example.com' },
    })
    expect(applyForwardedHeaders(req).url).toBe('https://rmf.example.com/api/auth/me')
  })

  it('keeps the request body', async () => {
    const req = new Request('http://pod:8080/api/auth/login', {
      method: 'POST',
      body: '{"username":"a"}',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'rmf.example.com' },
    })
    const out = applyForwardedHeaders(req)
    expect(out.method).toBe('POST')
    expect(await out.text()).toBe('{"username":"a"}')
  })

  it('leaves requests without forwarding headers alone', () => {
    const req = new Request('http://localhost:8080/api/auth/me')
    expect(applyForwardedHeaders(req)).toBe(req)
  })
})

describe('pathForLog', () => {
  it('redacts webhook tokens', () => {
    expect(pathForLog('/api/vendors/keenon/webhook/abc123')).toBe('/api/vendors/keenon/webhook/[redacted]')
  })
})
