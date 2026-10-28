import { z } from 'zod'
import type { Role, SessionUser } from '../../src/types/api'
import { HttpError, handler, json, methodNotAllowed, parseBody, requireUser } from '../lib/http'
import { getDummyHash, hashPassword, passwordSchema, verifyPassword } from '../lib/passwords'
import { clearSessionCookie, sessionCookie, signSession } from '../lib/session'
import { db } from '../lib/supabaseAdmin'

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MINUTES = 15
const INVALID_LOGIN = 'Invalid username or password'

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Username is required').max(64),
  password: z.string().min(1, 'Password is required').max(200),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(200),
  newPassword: passwordSchema,
})

interface UserRow {
  id: string
  username: string
  role: Role
  password_hash: string
  failed_attempts: number
  locked_until: string | null
}

async function login(req: Request): Promise<Response> {
  const { username, password } = await parseBody(req, loginSchema)

  const { data, error } = await db()
    .from('app_users')
    .select('id, username, role, password_hash, failed_attempts, locked_until')
    .eq('username', username)
    .maybeSingle()
  if (error) throw error
  const user = data as UserRow | null

  if (!user) {
    await verifyPassword(password, await getDummyHash())
    throw new HttpError(401, INVALID_LOGIN)
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(429, `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`)
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const attempts = user.failed_attempts + 1
    const locked = attempts >= MAX_FAILED_ATTEMPTS
    await db()
      .from('app_users')
      .update({
        failed_attempts: locked ? 0 : attempts,
        locked_until: locked ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null,
      })
      .eq('id', user.id)
    throw new HttpError(401, INVALID_LOGIN)
  }

  await db()
    .from('app_users')
    .update({ failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() })
    .eq('id', user.id)

  const sessionUser: SessionUser = { id: user.id, username: user.username, role: user.role }
  const token = await signSession({ sub: user.id, username: user.username, role: user.role })
  return json(sessionUser, { headers: { 'set-cookie': sessionCookie(token, req) } })
}

async function changePassword(req: Request): Promise<Response> {
  const me = await requireUser(req)
  const { currentPassword, newPassword } = await parseBody(req, changePasswordSchema)

  const { data, error } = await db().from('app_users').select('password_hash').eq('id', me.id).single()
  if (error) throw error
  if (!(await verifyPassword(currentPassword, data.password_hash))) {
    throw new HttpError(400, 'Current password is incorrect')
  }

  const { error: updateError } = await db()
    .from('app_users')
    .update({ password_hash: await hashPassword(newPassword) })
    .eq('id', me.id)
  if (updateError) throw updateError
  return json({ ok: true })
}

export default handler(async (req, params) => {
  switch (params.action) {
    case 'login':
      if (req.method !== 'POST') methodNotAllowed()
      return login(req)
    case 'logout':
      if (req.method !== 'POST') methodNotAllowed()
      return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie(req) } })
    case 'me':
      if (req.method !== 'GET') methodNotAllowed()
      return json(await requireUser(req))
    case 'password':
      if (req.method !== 'POST') methodNotAllowed()
      return changePassword(req)
    default:
      throw new HttpError(404, 'Not found')
  }
})
