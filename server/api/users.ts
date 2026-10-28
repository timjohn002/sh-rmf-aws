import { z } from 'zod'
import type { AppUser } from '../../src/types/api'
import {
  HttpError,
  handler,
  isUniqueViolation,
  json,
  methodNotAllowed,
  parseBody,
  requireAdmin,
} from '../lib/http'
import { hashPassword, passwordSchema, roleSchema, usernameSchema } from '../lib/passwords'
import { db } from '../lib/supabaseAdmin'

const PUBLIC_COLUMNS = 'id, username, role, created_at, last_login_at, locked_until'

const createSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema,
})

const resetSchema = z.object({ password: passwordSchema })

async function listUsers(): Promise<Response> {
  const { data, error } = await db().from('app_users').select(PUBLIC_COLUMNS).order('username')
  if (error) throw error
  return json(data as AppUser[])
}

async function createUser(req: Request): Promise<Response> {
  const { username, password, role } = await parseBody(req, createSchema)
  const { data, error } = await db()
    .from('app_users')
    .insert({ username, role, password_hash: await hashPassword(password) })
    .select(PUBLIC_COLUMNS)
    .single()
  if (isUniqueViolation(error)) throw new HttpError(409, `Username "${username}" is already taken`)
  if (error) throw error
  return json(data as AppUser, { status: 201 })
}

async function deleteUser(meId: string, id: string): Promise<Response> {
  if (id === meId) throw new HttpError(400, 'You cannot delete your own account')

  const { data: target, error } = await db().from('app_users').select('role').eq('id', id).maybeSingle()
  if (error) throw error
  if (!target) throw new HttpError(404, 'User not found')

  if (target.role === 'admin') {
    const { count, error: countError } = await db()
      .from('app_users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
    if (countError) throw countError
    if ((count ?? 0) <= 1) throw new HttpError(400, 'You cannot delete the last admin')
  }

  const { error: deleteError } = await db().from('app_users').delete().eq('id', id)
  if (deleteError) throw deleteError
  return json({ ok: true })
}

async function resetPassword(req: Request, id: string): Promise<Response> {
  const { password } = await parseBody(req, resetSchema)
  const { data, error } = await db()
    .from('app_users')
    .update({ password_hash: await hashPassword(password), failed_attempts: 0, locked_until: null })
    .eq('id', id)
    .select('id')
  if (error) throw error
  if (!data.length) throw new HttpError(404, 'User not found')
  return json({ ok: true })
}

export default handler(async (req, params) => {
  const me = await requireAdmin(req)
  const id = params.id
  const isPasswordRoute = new URL(req.url).pathname.endsWith('/password')

  if (!id) {
    if (req.method === 'GET') return listUsers()
    if (req.method === 'POST') return createUser(req)
    methodNotAllowed()
  }
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'User not found')

  if (isPasswordRoute) {
    if (req.method === 'POST') return resetPassword(req, id)
    methodNotAllowed()
  }
  if (req.method === 'DELETE') return deleteUser(me.id, id)
  methodNotAllowed()
})
