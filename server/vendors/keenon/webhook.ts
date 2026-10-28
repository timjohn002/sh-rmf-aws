import { createHash, timingSafeEqual } from 'node:crypto'
import type { RobotTask } from '../../../src/types/api'
import type { RobotPatch, SignatureCheck, WebhookInterpretation } from '../types'
import {
  KEENON_BIZ_TASK_STATE,
  KEENON_CALL_TASK_STATUS,
  KEENON_CLEAN_MAIN_STATE,
  KEENON_CLEAN_SUB_STATE,
  KEENON_IGNORED_TYPES,
  KEENON_ORDER_STATUS,
  KEENON_TASK_ERRORS,
  KEENON_TASK_STATE,
  KEENON_TASK_TYPE,
  KEENON_WORK_STATE,
} from './types'

/** Allowed clock difference for X-Timestamp. */
const TIMESTAMP_TOLERANCE_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// Signature (Appendix 2): MD5("body=<raw>&nonce=<nonce>&timestamp=<ts>&<client_secret>")
// ---------------------------------------------------------------------------

export function computeKeenonSignature(rawBody: string, nonce: string, timestamp: string, secret: string): string {
  return createHash('md5').update(`body=${rawBody}&nonce=${nonce}&timestamp=${timestamp}&${secret}`, 'utf8').digest('hex')
}

export function verifyKeenonSignature(
  rawBody: string,
  headers: Headers,
  secret: string | undefined,
  now = Date.now(),
): SignatureCheck {
  const signature = headers.get('x-signature')?.trim()
  const nonce = headers.get('x-nonce')?.trim()
  const timestamp = headers.get('x-timestamp')?.trim()

  if (!signature || !nonce || !timestamp) {
    const missing = [!signature && 'X-Signature', !nonce && 'X-Nonce', !timestamp && 'X-Timestamp'].filter(Boolean)
    return { status: 'missing', detail: `Missing ${missing.join(', ')}` }
  }
  if (!secret) return { status: 'not_checked', detail: 'No client secret configured' }

  const expected = computeKeenonSignature(rawBody, nonce, timestamp, secret)
  const given = signature.toLowerCase()
  const matches =
    given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  if (!matches) return { status: 'invalid', detail: 'Signature does not match' }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TIMESTAMP_TOLERANCE_MS) {
    return { status: 'invalid', detail: 'Signature matches but X-Timestamp is too old or invalid' }
  }
  return { status: 'valid' }
}

// ---------------------------------------------------------------------------
// Callback classification (Appendix 1)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v.trim() || null : typeof v === 'number' ? String(v) : null

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

const bool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1) return true
  if (v === 'false' || v === 0) return false
  return null
}

/** Several Keenon callbacks omit `bizType`; recognise them by shape. */
function detectShape(o: Obj): string | null {
  if ('orderNo' in o && 'orderStatus' in o) return 'HotelOrderStatus'
  if (Array.isArray(o.taskDetails)) return 'HotelRobotBizTask'
  if ('mainState' in o && ('globalState' in o || 'hardwareState' in o || 'subState' in o)) return 'CleanRobotStatus'
  if ('taskNo' in o && 'taskState' in o) return 'RobotTaskState'
  if ('taskNo' in o && 'taskStatus' in o) return 'CreateTask'
  if (isObj(o.robotPos)) return 'RobotPositionType'
  return null
}

export function classifyKeenonCallback(body: unknown): { type: string; data: Obj } {
  if (!isObj(body)) return { type: 'Unknown', data: {} }
  const bizType = str(body.bizType)
  if (bizType) return { type: bizType, data: isObj(body.data) ? body.data : body }
  const inner = isObj(body.data) ? body.data : body
  return { type: detectShape(inner) ?? detectShape(body) ?? 'Unknown', data: inner }
}

function taskError(code: number | null, state: string): Pick<RobotTask, 'error_code' | 'error_message'> {
  const relevant = state === 'failed' || state === 'cancelled'
  return {
    error_code: code,
    error_message: code !== null && relevant ? (KEENON_TASK_ERRORS[code] ?? `Robot error ${code}`) : null,
  }
}

function withoutNulls(patch: RobotPatch): RobotPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)) as RobotPatch
}

/** Turn a Keenon callback body into a robot update. Pure: no I/O. */
export function interpretKeenonCallback(body: unknown, now: Date = new Date()): WebhookInterpretation {
  const { type, data } = classifyKeenonCallback(body)
  const updatedAt = now.toISOString()

  const result = (robotSn: string | null, patch: RobotPatch | null): WebhookInterpretation =>
    robotSn
      ? { eventType: type, robotExternalId: robotSn, patch, status: 'processed' }
      : { eventType: type, robotExternalId: null, patch: null, status: 'ignored', note: 'No robot serial number in payload' }

  switch (type) {
    case 'RobotOnlineStatus': {
      const online = bool(data.onlineStatus)
      return result(str(data.robotSn), withoutNulls({ online, work_state: online === false ? 'offline' : undefined }))
    }

    case 'RobotOnlineType':
      return result(str(data.robotSn), withoutNulls({ online_type: str(data.onlineType) }))

    case 'RobotPowerInfo': {
      const power = isObj(data.power) ? data.power : data
      const chargeStatus = num(power.chargeStatus)
      return result(
        str(data.robotSn),
        withoutNulls({ battery: num(power.batteryLevel), charging: chargeStatus === null ? null : chargeStatus === 1 }),
      )
    }

    case 'RobotWorkState': {
      const robotState = num(data.robotState)
      const workState = robotState !== null ? KEENON_WORK_STATE[robotState as keyof typeof KEENON_WORK_STATE] : undefined
      return result(
        str(data.robotSn),
        withoutNulls({ work_state: workState ?? 'unknown', can_be_called: bool(data.canBeCalled) }),
      )
    }

    case 'RobotTaskState': {
      const state = KEENON_TASK_STATE[num(data.taskState) ?? -99] ?? 'unknown'
      const task: RobotTask = {
        source: type,
        task_no: str(data.taskNo),
        state,
        type: KEENON_TASK_TYPE[num(data.taskType) ?? -99] ?? str(data.taskType),
        ...taskError(num(data.errorCode), state),
        detail: {
          task_source: num(data.taskNoType) === 2 ? 'local' : 'remote',
          sub_tasks: Array.isArray(data.subTaskInfoList) ? data.subTaskInfoList : [],
        },
        updated_at: updatedAt,
      }
      return result(str(data.robotSn), { current_task: task })
    }

    case 'CreateTask': {
      const taskData = isObj(data.taskData) ? data.taskData : {}
      const state = KEENON_CALL_TASK_STATUS[num(data.taskStatus) ?? -99] ?? 'unknown'
      const task: RobotTask = {
        source: type,
        task_no: str(data.taskNo),
        state,
        type: 'Remote call',
        ...taskError(num(data.errorCode), state),
        detail: {
          remark: str(data.remark),
          remaining_distance_m: num(taskData.remainingDistance),
          queue_position: num(taskData.waitQueuing),
          last_update_time: str(taskData.lastUpdateTime),
        },
        updated_at: updatedAt,
      }
      return result(str(taskData.robotSn) ?? str(data.robotSn), { current_task: task })
    }

    case 'HotelRobotBizTask': {
      const task: RobotTask = {
        source: type,
        task_no: str(data.uuid),
        state: KEENON_BIZ_TASK_STATE[num(data.taskState) ?? -99] ?? 'unknown',
        type: 'Hotel delivery',
        error_code: null,
        error_message: null,
        detail: {
          store_id: str(data.storeId),
          total_time_s: num(data.totalTime),
          total_mileage: num(data.totalMileage),
          sub_tasks: Array.isArray(data.taskDetails) ? data.taskDetails : [],
        },
        updated_at: updatedAt,
      }
      return result(str(data.robotSn), { current_task: task })
    }

    case 'HotelOrderStatus': {
      const status = num(data.orderStatus)
      return {
        eventType: type,
        robotExternalId: null,
        patch: null,
        status: 'ignored',
        note: `Order ${str(data.orderNo) ?? '?'} is ${KEENON_ORDER_STATUS[status ?? -99] ?? `status ${status}`}; orders aren't linked to robots yet`,
      }
    }

    case 'CleanRobotStatus': {
      const main = num(data.mainState)
      const sub = num(data.subState)
      const workState = main !== null ? KEENON_CLEAN_MAIN_STATE[main as keyof typeof KEENON_CLEAN_MAIN_STATE] : undefined
      return result(
        str(data.robotSn),
        withoutNulls({
          online: main === null ? null : main !== -1,
          work_state: workState ?? 'unknown',
          vendor_status: {
            kind: 'cleaning',
            main_state: main,
            sub_state: sub,
            sub_state_label: sub !== null ? (KEENON_CLEAN_SUB_STATE[sub] ?? null) : null,
            global_state: data.globalState ?? null,
            hardware_state: data.hardwareState ?? null,
            child_state: data.childState ?? null,
            update_time: num(data.updateTime),
          },
        }),
      )
    }

    default: {
      if (KEENON_IGNORED_TYPES.has(type)) {
        const robotSn = str(data.robotSn) ?? str(data.deviceName)
        return { eventType: type, robotExternalId: robotSn, patch: null, status: 'ignored', note: 'Logged only (not handled yet)' }
      }
      return { eventType: type, robotExternalId: null, patch: null, status: 'ignored', note: 'Unrecognised callback' }
    }
  }
}
