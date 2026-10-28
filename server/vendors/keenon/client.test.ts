import { describe, expect, it, vi } from 'vitest'
import { KeenonClient, KeenonError } from './client'

type Reply = { status?: number; body: unknown }

/** fetch mock that replays `replies` in order and records requests. */
function mockFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const reply = replies.shift()
    if (!reply) throw new Error('No more mocked replies')
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return new Response(text, { status: reply.status ?? 200 })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

const TOKEN = { body: { access_token: 'tok-1', token_type: 'bearer', expires_in: 7200, scope: 'all' } }

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof KeenonClient>[0]> = {}) {
  return new KeenonClient({ baseUrl: 'https://keenon.test', clientId: 'id', clientSecret: 'secret', fetchImpl, ...extra })
}

describe('KeenonClient', () => {
  it('exchanges credentials for a token as a form post, then reuses it', async () => {
    const saveToken = vi.fn(async () => {})
    const { fetchImpl, calls } = mockFetch([TOKEN, { body: { code: 610000, data: [1] } }, { body: { code: 610000, data: [2] } }])
    const c = client(fetchImpl, { saveToken })

    expect(await c.get('/a')).toEqual([1])
    expect(await c.get('/b')).toEqual([2])

    expect(calls).toHaveLength(3) // one token request only
    expect(calls[0].url).toBe('https://keenon.test/api/open/oauth/token')
    expect(String(calls[0].init.body)).toBe('client_id=id&client_secret=secret&grant_type=client_credentials')
    expect(new Headers(calls[1].init.headers).get('authorization')).toBe('bearer tok-1')
    expect(saveToken).toHaveBeenCalledOnce()
  })

  it('uses a cached token until shortly before it expires', async () => {
    let now = 0
    const { fetchImpl, calls } = mockFetch([{ body: { code: 610000, data: 'x' } }, TOKEN, { body: { code: 610000, data: 'y' } }])
    const c = client(fetchImpl, { cachedToken: { token: 'cached', expiresAt: new Date(120_000) }, now: () => now })

    await c.get('/a')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('bearer cached')

    now = 70_000 // within the 60 s safety margin → refresh
    await c.get('/b')
    expect(calls[1].url).toContain('/oauth/token')
  })

  it('refreshes the token once when Keenon reports 610401', async () => {
    const { fetchImpl, calls } = mockFetch([
      { body: { code: 610401, msg: 'Token verification failed' } },
      TOKEN,
      { body: { code: 610000, data: 'ok' } },
    ])
    const c = client(fetchImpl, { cachedToken: { token: 'stale', expiresAt: new Date(Date.now() + 3_600_000) } })
    expect(await c.get('/x')).toBe('ok')
    expect(calls.map((c) => c.url)).toEqual([
      'https://keenon.test/x',
      'https://keenon.test/api/open/oauth/token',
      'https://keenon.test/x',
    ])
  })

  it('explains IP whitelisting (617000) and rate limiting (610609)', async () => {
    const { fetchImpl } = mockFetch([TOKEN, { body: { code: 617000, msg: 'Request IP has been restricted' } }])
    const err = (await client(fetchImpl).get('/x').catch((e: unknown) => e)) as KeenonError
    expect(err).toBeInstanceOf(KeenonError)
    expect(err.code).toBe(617000)
    expect(err.message).toMatch(/whitelisted/)

    const { fetchImpl: f2 } = mockFetch([TOKEN, { body: { code: 610609, msg: 'too frequent' } }])
    await expect(client(f2).get('/x')).rejects.toThrow(/Too many requests/)
  })

  it('reports wrong credentials from the token endpoint (610001)', async () => {
    const { fetchImpl } = mockFetch([{ status: 401, body: { code: 610001, msg: 'Wrong user name or password' } }])
    await expect(client(fetchImpl).getToken()).rejects.toThrow(/Wrong client ID or client secret/)
  })

  it('handles non-JSON and network failures', async () => {
    const { fetchImpl } = mockFetch([{ status: 502, body: '<html>Bad gateway</html>' }])
    await expect(client(fetchImpl).getToken()).rejects.toThrow(/not JSON/)

    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(client(failing).getToken()).rejects.toThrow(/Could not reach Keenon at https:\/\/keenon.test/)
  })

  it('accepts the {code:200, status:0} reply format (robot location)', async () => {
    const { fetchImpl } = mockFetch([
      TOKEN,
      { body: { traceId: 'x', msg: 'success', code: 200, data: { floor: '2' }, status: 0 } },
    ])
    expect(await client(fetchImpl).get('/api/open/custom/robot/location')).toEqual({ floor: '2' })
  })

  it('handles string error codes', async () => {
    const { fetchImpl } = mockFetch([TOKEN, { body: { msg: '未知异常', code: '610500', status: 1 } }])
    const err = (await client(fetchImpl).get('/x').catch((e: unknown) => e)) as KeenonError
    expect(err.code).toBe(610500)
    expect(err.message).toMatch(/Keenon server error/)
  })

  it('adds query parameters', async () => {
    const { fetchImpl, calls } = mockFetch([TOKEN, { body: { code: 610000, data: [] } }])
    await client(fetchImpl).get('/api/open/data/v1/store/robot/list', { storeId: 'S 1', skip: undefined })
    expect(calls[1].url).toBe('https://keenon.test/api/open/data/v1/store/robot/list?storeId=S+1')
  })
})
