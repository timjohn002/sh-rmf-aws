import { z } from 'zod'
import type { SessionUser } from '../../src/types/api'
import { readSessionCookie, verifySession } from './session'
import { db } from './supabaseAdmin'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new HttpError(400, 'Request body must be JSON')
  }
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid request')
  }
  return result.data
}

/** Reject cross-site state-changing requests (defence in depth on top of SameSite=Strict). */
function checkOrigin(req: Request) {
  if (req.method === 'GET' || req.method === 'HEAD') return
  const origin = req.headers.get('origin')
  if (origin && new URL(origin).host !== new URL(req.url).host) {
    throw new HttpError(403, 'Cross-origin request rejected')
  }
}

/**
 * Verify the session cookie and re-read the user from the database, so deleted
 * users and role changes take effect immediately.
 */
export async function requireUser(req: Request): Promise<SessionUser> {
  const token = readSessionCookie(req)
  const claims = token ? await verifySession(token) : null
  if (!claims) throw new HttpError(401, 'Not signed in')

  const { data, error } = await db()
    .from('app_users')
    .select('id, username, role')
    .eq('id', claims.sub)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(401, 'Not signed in')
  return data as SessionUser
}

export async function requireAdmin(req: Request): Promise<SessionUser> {
  const user = await requireUser(req)
  if (user.role !== 'admin') throw new HttpError(403, 'Admin access required')
  return user
}

type Params = Record<string, string | undefined>

/**
 * Wrap a function handler with origin checks and uniform error responses.
 * Server-to-server endpoints (vendor webhooks) pass `checkOrigin: false`.
 */
export function handler(
  fn: (req: Request, params: Params) => Promise<Response>,
  options: { checkOrigin?: boolean } = {},
) {
  return async (req: Request, context: { params?: Params }): Promise<Response> => {
    try {
      if (options.checkOrigin !== false) checkOrigin(req)
      return await fn(req, context.params ?? {})
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status })
      console.error(err)
      return json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}

export function methodNotAllowed(): never {
  throw new HttpError(405, 'Method not allowed')
}

/** Postgres unique_violation. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
}
