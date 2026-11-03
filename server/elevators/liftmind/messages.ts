// LiftMind D Mode (v2.2607) messages and topics. Pure: no I/O.
// Robots publish to liftmind/{manufacturer_id}/{robot_id}/v2/request|status and receive
// everything on …/v2/response.

export const SERVICE_STATUS_TOPIC = 'liftmind/service/robot/status'

export type TopicKind = 'request' | 'status' | 'response'

export function robotTopic(manufacturerId: string, robotId: string, kind: TopicKind): string {
  return `liftmind/${manufacturerId}/${robotId}/v2/${kind}`
}

export function parseRobotTopic(topic: string): { manufacturerId: string; robotId: string; kind: TopicKind } | null {
  const m = /^liftmind\/([^/]+)\/([^/]+)\/v2\/(request|status|response)$/.exec(topic)
  return m ? { manufacturerId: m[1], robotId: m[2], kind: m[3] as TopicKind } : null
}

/** New titles LiftMind has announced, mapped to the current official ones. */
const FUTURE_TITLES: Record<string, string> = {
  ELEVATOR_REQUEST_RESPONSE: 'ELEVATOR_RESPONSE',
  CANCEL_MISSION: 'CANCEL_REQUEST',
  CANCEL_MISSION_RESPONSE: 'CANCEL_RESPONSE',
  ABORT_MISSION: 'ABORT_REQUEST',
}

export function normalizeTitle(title: unknown): string {
  const t = typeof title === 'string' ? title.trim().toUpperCase() : ''
  return FUTURE_TITLES[t] ?? t
}

/** A message received from LiftMind, with its title normalized. */
export interface LiftMindIncoming {
  title: string
  uuid?: string
  is_success?: boolean
  reason?: string
  floor?: string
  elevator_uuid?: string
  name?: string
  queue_length?: Record<string, number | null>
}

export function parseIncoming(payload: unknown): LiftMindIncoming | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  const title = normalizeTitle(p.title)
  if (!title) return null
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
  return {
    title,
    uuid: str(p.uuid),
    is_success: typeof p.is_success === 'boolean' ? p.is_success : undefined,
    reason: str(p.reason),
    floor: str(p.floor),
    elevator_uuid: str(p.elevator_uuid),
    name: str(p.name),
    queue_length:
      p.queue_length && typeof p.queue_length === 'object' ? (p.queue_length as Record<string, number | null>) : undefined,
  }
}

/** LiftMind's service status topic carries `online` / `offline` (plain or as JSON). */
export function parseServiceStatus(payload: unknown): 'online' | 'offline' | null {
  const value =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? String((payload as Record<string, unknown>).status ?? '')
        : ''
  const v = value.trim().replace(/^"|"$/g, '').toLowerCase()
  return v === 'online' || v === 'offline' ? v : null
}

/** Decode an MQTT payload: JSON when it parses, otherwise the text. */
export function decodePayload(buf: Buffer | string): unknown {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// --- Messages the robot (we) sends ----------------------------------------------------------

export interface SeparatedModeOptions {
  enabled: boolean
  retry_count?: number
  enable_priority_mode?: boolean
  delay_seconds_after_full_open?: number
  space_threshold?: number
}

export interface OutgoingMessage {
  title: string
  [field: string]: unknown
}

export function elevatorRequest(opts: {
  uuid: string
  fromFloor: string
  toFloor: string
  elevatorUuid?: string | null
  lobbyUuid?: string | null
  separated?: SeparatedModeOptions
  strictDirection?: boolean
}): OutgoingMessage {
  // LiftMind uses elevator_uuid when both are given, so send only one.
  const target = opts.elevatorUuid ? { elevator_uuid: opts.elevatorUuid } : { lobby_uuid: opts.lobbyUuid ?? undefined }
  return {
    uuid: opts.uuid,
    title: 'ELEVATOR_REQUEST',
    from_floor: opts.fromFloor,
    to_floor: opts.toFloor,
    ...target,
    ...(opts.separated ? { separated_mode_options: opts.separated } : {}),
    ...(opts.strictDirection !== undefined ? { strict_direction_matching: opts.strictDirection } : {}),
  }
}

export const enteredElevator = (uuid: string, ok: boolean): OutgoingMessage => ({
  uuid,
  title: 'ENTERED_ELEVATOR',
  is_success: ok,
})

export const exitedElevator = (uuid: string, ok: boolean): OutgoingMessage => ({
  uuid,
  title: 'EXITED_ELEVATOR',
  is_success: ok,
})

export const cancelRequest = (uuid: string): OutgoingMessage => ({ uuid, title: 'CANCEL_REQUEST' })

export const recoveryRequest = (uuid: string, toFloor: string): OutgoingMessage => ({
  uuid,
  title: 'RECOVERY_REQUEST',
  to_floor: toFloor,
})

export function checkRequest(uuid: string, target: { elevatorUuid?: string | null; lobbyUuid?: string | null }): OutgoingMessage {
  return {
    uuid,
    title: 'CHECK_REQUEST',
    ...(target.elevatorUuid ? { elevator_uuid: target.elevatorUuid } : { lobby_uuid: target.lobbyUuid ?? undefined }),
  }
}

/** Status reports go to …/status; everything else the robot sends goes to …/request. */
export function topicKindFor(title: string): 'request' | 'status' {
  return title === 'ENTERED_ELEVATOR' || title === 'EXITED_ELEVATOR' ? 'status' : 'request'
}
