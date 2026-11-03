// Persistence for the Elevators page: the LiftMind connection (one row) and the lifts with the
// floors they serve and the robots allowed to use them. Keeps the MQTT connection in step.

import { X509Certificate } from 'node:crypto'
import { z } from 'zod'
import type {
  CaCertInfo,
  Elevator,
  ElevatorImportResult,
  ElevatorInput,
  LiftMindConnectionUpdate,
  LiftMindConnectionView,
} from '../../src/types/api'
import { logJson } from '../app'
import { HttpError, isUniqueViolation } from '../lib/http'
import { db } from '../lib/supabaseAdmin'
import { type LiftMindSettings, liftmind } from './liftmind/connection'

interface ConnectionRow {
  enabled: boolean
  mqtt_host: string
  mqtt_port: number
  use_tls: boolean
  ca_cert: string | null
  client_id_prefix: string
  manufacturer_id: string
  username: string
  password: string
  updated_at: string | null
}

const EMPTY_CONNECTION: ConnectionRow = {
  enabled: true,
  mqtt_host: '',
  mqtt_port: 8883,
  use_tls: true,
  ca_cert: null,
  client_id_prefix: '',
  manufacturer_id: '',
  username: '',
  password: '',
  updated_at: null,
}

export async function loadConnection(): Promise<ConnectionRow> {
  const { data, error } = await db().from('liftmind_connection').select('*').maybeSingle()
  if (error) throw error
  const { id: _id, ...row } = (data ?? {}) as Partial<ConnectionRow> & { id?: boolean }
  return { ...EMPTY_CONNECTION, ...row }
}

export function certInfo(pem: string | null, now = Date.now()): CaCertInfo | null {
  if (!pem) return null
  try {
    const cert = new X509Certificate(pem)
    const validTo = new Date(cert.validTo)
    return {
      subject: cert.subject.split('\n').join(', '),
      issuer: cert.issuer.split('\n').join(', '),
      valid_to: validTo.toISOString(),
      expired: validTo.getTime() < now,
    }
  } catch {
    return null
  }
}

/** Trimmed PEM, or a 400 when it isn't a certificate. */
export function validCaCert(pem: string): string {
  const trimmed = pem.trim()
  if (!trimmed.includes('-----BEGIN CERTIFICATE-----') || !certInfo(trimmed)) {
    throw new HttpError(400, 'The CA certificate must be a PEM file (-----BEGIN CERTIFICATE----- …).')
  }
  return `${trimmed}\n`
}

export function connectionView(row: ConnectionRow): LiftMindConnectionView {
  const { password, ca_cert, ...rest } = row
  return { ...rest, password: { set: !!password, last4: null }, ca_cert: certInfo(ca_cert) }
}

export async function saveConnection(update: LiftMindConnectionUpdate): Promise<ConnectionRow> {
  const { password, ca_cert, ...fields } = update
  const row = {
    id: true,
    ...fields,
    ...(password ? { password } : {}),
    ...(ca_cert === null ? { ca_cert: null } : ca_cert !== undefined ? { ca_cert: validCaCert(ca_cert) } : {}),
  }
  const { error } = await db().from('liftmind_connection').upsert(row, { onConflict: 'id' })
  if (error) throw error
  return loadConnection()
}

// --- Lifts ----------------------------------------------------------------------------------

interface ElevatorRow extends Omit<Elevator, 'floors' | 'robots'> {
  elevator_floors: Elevator['floors']
  elevator_robots: Elevator['robots']
}

const ELEVATOR_COLUMNS = '*, elevator_floors(floor_id, liftmind_floor), elevator_robots(liftmind_robot_id, robot_id)'

function toElevator({ elevator_floors, elevator_robots, ...row }: ElevatorRow): Elevator {
  return { ...row, floors: elevator_floors ?? [], robots: elevator_robots ?? [] }
}

export async function listElevators(): Promise<Elevator[]> {
  const { data, error } = await db().from('elevators').select(ELEVATOR_COLUMNS).order('name')
  if (error) throw error
  return (data as ElevatorRow[]).map(toElevator)
}

export async function getElevator(id: string): Promise<Elevator> {
  const { data, error } = await db().from('elevators').select(ELEVATOR_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404, 'Lift not found')
  return toElevator(data as ElevatorRow)
}

/** Create (id null) or update a lift; its floors and robots are replaced as a whole. */
export async function saveElevator(id: string | null, input: ElevatorInput): Promise<Elevator> {
  const { floors, robots, ...fields } = input
  const query = id ? db().from('elevators').update(fields).eq('id', id) : db().from('elevators').insert(fields)
  const { data, error } = await query.select('id').maybeSingle()
  if (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, `Another lift already has elevator UUID ${fields.elevator_uuid}.`)
    throw error
  }
  if (!data) throw new HttpError(404, 'Lift not found')
  const elevatorId = (data as { id: string }).id

  for (const table of ['elevator_floors', 'elevator_robots'] as const) {
    const { error: delError } = await db().from(table).delete().eq('elevator_id', elevatorId)
    if (delError) throw delError
  }
  if (floors.length) {
    const { error: floorError } = await db()
      .from('elevator_floors')
      .insert(floors.map((f) => ({ ...f, elevator_id: elevatorId })))
    if (floorError) {
      if ((floorError as { code?: string }).code === '23503') throw new HttpError(400, 'One of the floors no longer exists.')
      throw floorError
    }
  }
  if (robots.length) {
    const { error: robotError } = await db()
      .from('elevator_robots')
      .insert(robots.map((r) => ({ ...r, elevator_id: elevatorId })))
    if (robotError) throw robotError
  }
  return getElevator(elevatorId)
}

export async function deleteElevator(id: string): Promise<void> {
  const { error } = await db().from('elevators').delete().eq('id', id)
  if (error) throw error
}

// --- setting.json import --------------------------------------------------------------------

const settingsJsonSchema = z.object({
  manufacturer_id: z
    .string({ error: 'setting.json has no manufacturer_id' })
    .trim()
    .min(1, 'setting.json has no manufacturer_id'),
  username: z.string().trim().optional(),
  password: z.string().optional(),
  robots: z
    .array(
      z.object({
        uuid: z.string().trim().min(1),
        controllable_elevators: z.array(z.object({ elevator_uuid: z.string().trim().min(1) })).default([]),
      }),
    )
    .default([]),
})

/** What a setting.json from Owlsome Tech contains: connection fields and robots per elevator. */
export function parseSettingsJson(raw: unknown): {
  connection: Pick<LiftMindConnectionUpdate, 'manufacturer_id' | 'username' | 'password'>
  robotsByElevator: Map<string, string[]>
} {
  const parsed = settingsJsonSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpError(400, `Not a LiftMind setting.json: ${parsed.error.issues[0]?.message ?? 'unexpected format'}`)
  }
  const { manufacturer_id, username, password, robots } = parsed.data
  const robotsByElevator = new Map<string, string[]>()
  for (const robot of robots) {
    for (const { elevator_uuid } of robot.controllable_elevators) {
      const list = robotsByElevator.get(elevator_uuid) ?? []
      if (!list.includes(robot.uuid)) list.push(robot.uuid)
      robotsByElevator.set(elevator_uuid, list)
    }
  }
  return { connection: { manufacturer_id, username, password }, robotsByElevator }
}

/** Short default name for an imported lift, e.g. "Lift 717c". */
export function defaultLiftName(elevatorUuid: string): string {
  return `Lift ${elevatorUuid.replace(/[^a-z0-9]/gi, '').slice(-4)}`
}

export async function importSettings(raw: unknown): Promise<ElevatorImportResult> {
  const { connection, robotsByElevator } = parseSettingsJson(raw)
  await saveConnection(connection)

  const existing = new Map((await listElevators()).map((e) => [e.elevator_uuid, e]))
  const result: ElevatorImportResult = { elevators_created: 0, elevators_updated: 0, robots: 0 }
  for (const [elevatorUuid, robotIds] of robotsByElevator) {
    const lift = existing.get(elevatorUuid)
    if (!lift) {
      await saveElevator(null, {
        name: defaultLiftName(elevatorUuid),
        elevator_uuid: elevatorUuid,
        lobby_uuid: null,
        enabled: true,
        floors: [],
        robots: robotIds.map((id) => ({ liftmind_robot_id: id, robot_id: null })),
      })
      result.elevators_created++
      result.robots += robotIds.length
      continue
    }
    const known = new Set(lift.robots.map((r) => r.liftmind_robot_id))
    const added = robotIds.filter((id) => !known.has(id))
    if (added.length) {
      const { floors, robots, name, elevator_uuid, lobby_uuid, enabled } = lift
      await saveElevator(lift.id, {
        name,
        elevator_uuid,
        lobby_uuid,
        enabled,
        floors,
        robots: [...robots, ...added.map((id) => ({ liftmind_robot_id: id, robot_id: null }))],
      })
      result.elevators_updated++
      result.robots += added.length
    }
  }
  return result
}

// --- Keeping the MQTT connection in step ----------------------------------------------------

export async function liftmindSettings(): Promise<LiftMindSettings> {
  const row = await loadConnection()
  const { data, error } = await db().from('elevator_robots').select('liftmind_robot_id')
  if (error) throw error
  const robotIds = [...new Set((data as { liftmind_robot_id: string }[]).map((r) => r.liftmind_robot_id))].sort()
  return {
    enabled: row.enabled,
    host: row.mqtt_host.trim(),
    port: row.mqtt_port,
    useTls: row.use_tls,
    caCert: row.ca_cert,
    clientIdPrefix: row.client_id_prefix.trim(),
    manufacturerId: row.manufacturer_id.trim(),
    username: row.username,
    password: row.password,
    robotIds,
  }
}

let applied: string | null = null
let lastError: string | null = null

/** Reconnect when the saved settings (incl. the robot list) changed; never throws. */
export async function syncLiftMind(): Promise<void> {
  try {
    const settings = await liftmindSettings()
    lastError = null
    const key = JSON.stringify(settings)
    if (key === applied) return
    applied = key
    await liftmind.configure(settings)
  } catch (err) {
    applied = null
    const message = err instanceof Error ? err.message : String(err)
    // Called every 30 s: log a failure once, not on every attempt.
    if (message !== lastError) logJson('error', 'liftmind settings could not be applied', { error: message })
    lastError = message
  }
}
