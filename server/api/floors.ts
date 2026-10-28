import { z } from 'zod'
import type { Floor, PlanUploadTicket } from '../../src/types/api'
import {
  HttpError,
  handler,
  isUniqueViolation,
  json,
  methodNotAllowed,
  parseBody,
  requireUser,
} from '../lib/http'
import { PLAN_BUCKET, db } from '../lib/supabaseAdmin'

const SIGNED_URL_SECONDS = 60 * 60
const PLAN_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']

const floorFields = {
  name: z.string().trim().min(1, 'Name is required').max(64),
  level: z.number().int('Level must be a whole number').min(-100).max(500),
  elevation_m: z.number().finite(),
}

const createSchema = z.object({
  ...floorFields,
  elevation_m: floorFields.elevation_m.default(0),
})

const updateSchema = z
  .object({
    ...floorFields,
    scale_m_per_px: z.number().positive('Scale must be greater than 0').finite(),
    origin_x_px: z.number().finite(),
    origin_y_px: z.number().finite(),
    plan_path: z.string().min(1).max(512).nullable(),
    plan_width_px: z.number().int().positive().nullable(),
    plan_height_px: z.number().int().positive().nullable(),
  })
  .partial()

const uploadSchema = z.object({
  fileName: z.string().min(1).max(200),
  contentType: z.enum(PLAN_TYPES, 'Floor plans must be PNG, JPG, WebP or SVG images'),
})

type FloorRow = Omit<Floor, 'plan_url'>

async function withPlanUrls(rows: FloorRow[]): Promise<Floor[]> {
  const paths = rows.map((r) => r.plan_path).filter((p): p is string => !!p)
  const urls = new Map<string, string>()
  if (paths.length) {
    const { data, error } = await db().storage.from(PLAN_BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS)
    if (error) throw error
    for (const item of data) {
      if (item.path && item.signedUrl) urls.set(item.path, item.signedUrl)
    }
  }
  return rows.map((r) => ({ ...r, plan_url: r.plan_path ? (urls.get(r.plan_path) ?? null) : null }))
}

async function getFloorRow(id: string): Promise<FloorRow> {
  const { data, error } = await db().from('floors').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Floor not found')
  return data as FloorRow
}

function levelTaken(level: number | undefined): HttpError {
  return new HttpError(409, `Another floor already uses level ${level}`)
}

async function listFloors(): Promise<Response> {
  const { data, error } = await db().from('floors').select('*').order('level', { ascending: false })
  if (error) throw error
  return json(await withPlanUrls(data as FloorRow[]))
}

async function createFloor(req: Request): Promise<Response> {
  const input = await parseBody(req, createSchema)
  const { data, error } = await db().from('floors').insert(input).select('*').single()
  if (isUniqueViolation(error)) throw levelTaken(input.level)
  if (error) throw error
  const [floor] = await withPlanUrls([data as FloorRow])
  return json(floor, { status: 201 })
}

async function updateFloor(req: Request, id: string): Promise<Response> {
  const input = await parseBody(req, updateSchema)
  const current = await getFloorRow(id)

  const planChanged = input.plan_path !== undefined && input.plan_path !== current.plan_path
  if (planChanged && input.plan_path !== null && !input.plan_path!.startsWith(`${id}/`)) {
    throw new HttpError(400, 'Invalid plan path')
  }
  if (input.plan_path === null) {
    input.plan_width_px = null
    input.plan_height_px = null
  }

  const { data, error } = await db().from('floors').update(input).eq('id', id).select('*').single()
  if (isUniqueViolation(error)) throw levelTaken(input.level)
  if (error) throw error

  if (planChanged && current.plan_path) {
    await db().storage.from(PLAN_BUCKET).remove([current.plan_path])
  }
  const [floor] = await withPlanUrls([data as FloorRow])
  return json(floor)
}

async function deleteFloor(id: string): Promise<Response> {
  await getFloorRow(id)
  const { error } = await db().from('floors').delete().eq('id', id)
  if (error) throw error

  // Remove every file under this floor's folder, including abandoned uploads.
  const { data: files } = await db().storage.from(PLAN_BUCKET).list(id, { limit: 1000 })
  if (files?.length) {
    await db().storage.from(PLAN_BUCKET).remove(files.map((f) => `${id}/${f.name}`))
  }
  return json({ ok: true })
}

async function createUploadUrl(req: Request, id: string): Promise<Response> {
  const { fileName } = await parseBody(req, uploadSchema)
  await getFloorRow(id)

  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-100)
  const path = `${id}/${Date.now()}-${safeName}`
  const { data, error } = await db().storage.from(PLAN_BUCKET).createSignedUploadUrl(path)
  if (error) throw error
  const ticket: PlanUploadTicket = { path: data.path, signedUrl: data.signedUrl }
  return json(ticket)
}

export default handler(async (req, params) => {
  await requireUser(req)
  const id = params.id

  if (!id) {
    if (req.method === 'GET') return listFloors()
    if (req.method === 'POST') return createFloor(req)
    methodNotAllowed()
  }
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'Floor not found')

  if (new URL(req.url).pathname.endsWith('/plan-upload-url')) {
    if (req.method === 'POST') return createUploadUrl(req, id)
    methodNotAllowed()
  }
  if (req.method === 'PATCH') return updateFloor(req, id)
  if (req.method === 'DELETE') return deleteFloor(id)
  methodNotAllowed()
})
