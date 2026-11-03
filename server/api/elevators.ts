import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ElevatorCheckResult, ElevatorsResponse } from '../../src/types/api'
import { liftmind } from '../elevators/liftmind/connection'
import { checkRequest } from '../elevators/liftmind/messages'
import {
  connectionView,
  deleteElevator,
  getElevator,
  importSettings,
  listElevators,
  loadConnection,
  saveConnection,
  saveElevator,
  syncLiftMind,
} from '../elevators/store'
import { HttpError, handler, json, methodNotAllowed, parseBody, requireAdmin } from '../lib/http'

const text = (max: number) => z.string().trim().max(max)

const connectionSchema = z.object({
  enabled: z.boolean().optional(),
  mqtt_host: text(255).optional(),
  mqtt_port: z.number().int().min(1).max(65535).optional(),
  use_tls: z.boolean().optional(),
  client_id_prefix: text(64).optional(),
  manufacturer_id: text(128).optional(),
  username: text(128).optional(),
  password: z.string().max(256).optional(),
  ca_cert: z.string().max(64 * 1024).nullable().optional(),
})

const elevatorSchema = z
  .object({
    name: text(64).min(1, 'Name is required'),
    elevator_uuid: text(128).min(1, 'Elevator UUID is required'),
    lobby_uuid: text(128)
      .nullable()
      .transform((v) => v || null),
    enabled: z.boolean(),
    floors: z
      .array(z.object({ floor_id: z.uuid(), liftmind_floor: text(16).min(1, 'Every floor needs a LiftMind floor name') }))
      .max(300),
    robots: z.array(z.object({ liftmind_robot_id: text(128).min(1), robot_id: z.uuid().nullable() })).max(100),
  })
  .refine((e) => new Set(e.floors.map((f) => f.liftmind_floor)).size === e.floors.length, {
    message: 'Each LiftMind floor name can only be used once per lift',
  })
  .refine((e) => new Set(e.floors.map((f) => f.floor_id)).size === e.floors.length, { message: 'A floor is listed twice' })
  .refine((e) => new Set(e.robots.map((r) => r.liftmind_robot_id)).size === e.robots.length, {
    message: 'A robot is listed twice',
  })

const startSchema = z.object({
  robot: text(128).min(1),
  from_floor_id: z.uuid(),
  to_floor_id: z.uuid(),
  separated: z.boolean().default(false),
})

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['entered', 'exited']), ok: z.boolean() }),
  z.object({ action: z.literal('recover'), to_floor: text(16).min(1) }),
  z.object({ action: z.enum(['cancel', 'clear']) }),
])

async function overview(): Promise<ElevatorsResponse> {
  const [connection, elevators] = await Promise.all([loadConnection(), listElevators()])
  return { connection: connectionView(connection), elevators }
}

async function checkLift(id: string): Promise<ElevatorCheckResult> {
  const lift = await getElevator(id)
  const robot = lift.robots[0]?.liftmind_robot_id
  if (!robot) throw new HttpError(400, 'Add a LiftMind robot to this lift first: LiftMind answers on a robot’s topic.')
  const reply = await liftmind.request(robot, checkRequest(randomUUID(), { elevatorUuid: lift.elevator_uuid }), [
    'CHECK_RESPONSE',
  ])
  return { ok: reply.is_success !== false, queue_length: reply.queue_length ?? null, reason: reply.reason ?? null }
}

async function startTestRide(id: string, req: Request) {
  const input = await parseBody(req, startSchema)
  const lift = await getElevator(id)
  if (!lift.enabled) throw new HttpError(400, 'This lift is disabled.')
  if (!lift.robots.some((r) => r.liftmind_robot_id === input.robot)) {
    throw new HttpError(400, 'That robot is not allowed to use this lift.')
  }
  const from = lift.floors.find((f) => f.floor_id === input.from_floor_id)
  const to = lift.floors.find((f) => f.floor_id === input.to_floor_id)
  if (!from || !to) throw new HttpError(400, 'Both floors must be floors this lift serves.')
  if (from.floor_id === to.floor_id) throw new HttpError(400, 'Choose two different floors.')
  return liftmind.startTestRide({
    elevatorId: lift.id,
    elevatorName: lift.name,
    elevatorUuid: lift.elevator_uuid,
    robot: input.robot,
    fromFloor: from.liftmind_floor,
    toFloor: to.liftmind_floor,
    separated: input.separated,
  })
}

/**
 * /api/elevators[/<id>[/<action>]], plus /api/elevators/{connection,import,live} and
 * /api/elevators/test-ride/<action>. Admins only; parsed by hand like vendors.ts.
 */
export default handler(async (req) => {
  await requireAdmin(req)
  const [, , first, second, ...rest] = new URL(req.url).pathname.split('/').filter(Boolean)
  if (rest.length) throw new HttpError(404, 'Not found')

  if (!first) {
    if (req.method === 'GET') return json(await overview())
    if (req.method === 'POST') {
      const lift = await saveElevator(null, await parseBody(req, elevatorSchema))
      await syncLiftMind()
      return json(lift, { status: 201 })
    }
    methodNotAllowed()
  }

  switch (first) {
    case 'connection':
      if (second || req.method !== 'PUT') methodNotAllowed()
      await saveConnection(await parseBody(req, connectionSchema))
      await syncLiftMind()
      return json(await overview())
    case 'import':
      if (second || req.method !== 'POST') methodNotAllowed()
      {
        let raw: unknown
        try {
          raw = await req.json()
        } catch {
          throw new HttpError(400, 'setting.json must be valid JSON')
        }
        const result = await importSettings(raw)
        await syncLiftMind()
        return json(result)
      }
    case 'live':
      if (second || req.method !== 'GET') methodNotAllowed()
      return json(liftmind.snapshot())
    case 'test-ride':
      if (!second || req.method !== 'POST') methodNotAllowed()
      {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const parsed = actionSchema.safeParse({ ...body, action: second })
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid action')
        return json({ ride: liftmind.testRideAction(parsed.data) })
      }
  }

  if (!z.uuid().safeParse(first).success) throw new HttpError(404, 'Lift not found')
  if (!second) {
    if (req.method === 'PATCH') {
      const lift = await saveElevator(first, await parseBody(req, elevatorSchema))
      await syncLiftMind()
      return json(lift)
    }
    if (req.method === 'DELETE') {
      await deleteElevator(first)
      await syncLiftMind()
      return json({ ok: true })
    }
    methodNotAllowed()
  }
  if (req.method !== 'POST') methodNotAllowed()
  if (second === 'check') return json(await checkLift(first))
  if (second === 'test-ride') return json({ ride: await startTestRide(first, req) })
  throw new HttpError(404, 'Not found')
})
