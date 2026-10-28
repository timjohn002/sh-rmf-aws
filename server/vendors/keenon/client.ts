import { KEENON_GRANT_TYPE } from '../../../src/vendors/keenon/shared'
import { VendorApiError } from '../errors'
import { KEENON_CODE_MESSAGES, KEENON_OK } from './types'

const DEFAULT_TIMEOUT_MS = 8_000
/** Refresh the token this long before Keenon says it expires. */
const TOKEN_MARGIN_MS = 60_000

export class KeenonError extends VendorApiError {}

export function keenonCodeMessage(code: number, msg?: string): string {
  const known = KEENON_CODE_MESSAGES[code]
  return known ? `${known} (Keenon code ${code})` : `Keenon error ${code}: ${msg || 'unknown error'}`
}

export interface KeenonClientOptions {
  baseUrl: string
  clientId: string
  clientSecret: string
  /** Previously cached token, if any. */
  cachedToken?: { token: string; expiresAt: Date } | null
  saveToken?: (token: string, expiresAt: Date) => Promise<void>
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

type Query = Record<string, string | number | undefined>

export class KeenonClient {
  private token: string | null
  private expiresAt: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly opts: KeenonClientOptions) {
    this.token = opts.cachedToken?.token ?? null
    this.expiresAt = opts.cachedToken?.expiresAt.getTime() ?? 0
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
  }

  /** Seconds until the current token expires (null if none). */
  get tokenExpiresIn(): number | null {
    return this.token ? Math.max(0, Math.round((this.expiresAt - this.now()) / 1000)) : null
  }

  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.expiresAt - TOKEN_MARGIN_MS > this.now()) return this.token

    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      grant_type: KEENON_GRANT_TYPE,
    })
    const { status, data } = await this.send('/api/open/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })

    const record = (data ?? {}) as Record<string, unknown>
    if (typeof record.access_token !== 'string') {
      if (typeof record.code === 'number') {
        throw new KeenonError(record.code, keenonCodeMessage(record.code, String(record.msg ?? '')), status)
      }
      const detail = record.error_description ?? record.error ?? record.msg ?? `HTTP ${status}`
      throw new KeenonError(null, `Keenon did not issue a token: ${String(detail)}`, status)
    }

    const expiresIn = Number(record.expires_in) > 0 ? Number(record.expires_in) : 7200
    this.token = record.access_token
    this.expiresAt = this.now() + expiresIn * 1000
    await this.opts.saveToken?.(this.token, new Date(this.expiresAt))
    return this.token
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.call<T>('GET', path, { query })
  }

  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.call<T>('POST', path, { body, query })
  }

  /** Authenticated call; unwraps `{code, msg, data}` and retries once on an expired token. */
  private async call<T>(
    method: string,
    path: string,
    { query, body }: { query?: Query; body?: unknown },
    retried = false,
  ): Promise<T> {
    const token = await this.getToken(retried)
    const { status, data } = await this.send(withQuery(path, query), {
      method,
      headers: {
        authorization: `bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    const envelope = (data ?? {}) as { code?: number | string; msg?: string; data?: unknown; status?: number }
    // Keenon sometimes sends `code` as a string (e.g. "610500").
    const code = envelope.code === undefined || envelope.code === '' ? null : Number(envelope.code)
    if (code === 610401 && !retried) return this.call<T>(method, path, { query, body }, true)
    // Most endpoints answer 610000; some (e.g. robot location) answer {code: 200, status: 0}.
    const ok = code === KEENON_OK || (code === 200 && (envelope.status === undefined || envelope.status === 0))
    if (!ok) {
      if (code !== null && Number.isFinite(code)) {
        throw new KeenonError(code, keenonCodeMessage(code, envelope.msg), status)
      }
      throw new KeenonError(null, `Unexpected response from Keenon (HTTP ${status})`, status)
    }
    return envelope.data as T
  }

  private async send(path: string, init: RequestInit): Promise<{ status: number; data: unknown }> {
    const url = `${this.opts.baseUrl}${path}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? 'no response in time'
          : err instanceof Error
            ? err.message
            : String(err)
      throw new KeenonError(null, `Could not reach Keenon at ${this.opts.baseUrl}: ${reason}`)
    }

    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      throw new KeenonError(null, `Unexpected response from Keenon (HTTP ${res.status}, not JSON)`, res.status)
    }
    return { status: res.status, data }
  }
}

function withQuery(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}
