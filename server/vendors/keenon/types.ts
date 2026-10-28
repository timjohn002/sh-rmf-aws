// Keenon Cloud API enumerations (Keenon Cloud API Development Document V2.4.0).

export const KEENON_OK = 610000

/** Request return codes (§2.2, §3.4, robot control receipt table). */
export const KEENON_CODE_MESSAGES: Record<number, string> = {
  610001: 'Wrong client ID or client secret.',
  610401: 'Keenon rejected the access token (invalid or expired).',
  610403: 'This Keenon account has no permission for that resource.',
  610500: 'Keenon server error. Try again later.',
  610601: 'Keenon rejected the request parameters.',
  610609: 'Too many requests to Keenon. Wait a moment and try again.',
  614920: 'No robot available.',
  615001: 'The robot is offline.',
  615025: 'The robot did not respond in time.',
  617000:
    "This server's IP address isn't whitelisted with Keenon. Run the app from the whitelisted network (local `npm run dev`), or ask Keenon to whitelist this IP.",
}

/** Robot-side error codes on remote call tasks (§3.4 / §4.1 / §4.9). */
export const KEENON_TASK_ERRORS: Record<number, string> = {
  300: 'Remote call is not enabled on the robot',
  301: 'The robot is being set up',
  302: 'The robot is busy with another task',
  303: 'The robot refused the task',
  304: 'The robot has no such task',
  305: 'The robot cannot recognise the target point',
  400: 'The task was cancelled on the robot',
  401: 'The robot has no record of the task',
  402: 'Unknown robot error ended the task',
  403: 'The robot timed out the task',
  500: 'No available robot was found',
  501: 'The task stopped updating and was ended',
  502: 'The robot went offline',
  503: 'The robot is not registered for remote calls',
}

/** Remote call task status: CreateTask callback & task query (§4.1). */
export const KEENON_CALL_TASK_STATUS: Record<number, string> = {
  0: 'failed',
  1: 'queued',
  2: 'calling',
  3: 'in_progress',
  4: 'completed',
  5: 'cancelled',
  6: 'arrived',
  7: 'waiting',
}

/** Main task state in RobotTaskState callbacks (§4.9). */
export const KEENON_TASK_STATE: Record<number, string> = {
  0: 'failed',
  1: 'queued',
  2: 'calling',
  3: 'in_progress',
  4: 'completed',
  5: 'cancelled',
}

/** Task type in RobotTaskState callbacks (§4.9). */
export const KEENON_TASK_TYPE: Record<number, string> = {
  0: 'Non-task',
  1: 'Food delivery',
  2: 'Multi-point',
  3: 'Remote task',
  4: 'Remote tray return',
  5: 'Snack',
  6: 'Loop tray return',
  7: 'To dishwashing area',
  8: 'Welcoming',
  9: 'Greeting',
  10: 'Return to base',
  11: 'Charging',
  12: 'Charging and return',
  13: 'Direct to point',
}

/** RobotWorkState.robotState (§4.7) → normalized work state. */
export const KEENON_WORK_STATE = {
  1: 'busy',
  2: 'idle',
  3: 'operating',
  4: 'scheduling',
  5: 'charging',
  6: 'starting',
} as const

/** Robot list onlineType (§3.2). */
export const KEENON_ONLINE_TYPE: Record<number, string> = {
  2: 'Wi-Fi',
  3: '3G',
  4: '4G',
  5: 'unknown',
}

/** Remote dispatch order status (§4.5). */
export const KEENON_ORDER_STATUS: Record<number, string> = {
  100: 'queued',
  109: 'going to pick up',
  110: 'to be delivered',
  111: 'delivering',
  114: 'arrived',
  180: 'completed',
  190: 'exception',
  193: 'cancelled',
  390: 'cancelled by system',
  999: 'unknown',
}

/** HotelRobotBizTask main task state (§4.6). */
export const KEENON_BIZ_TASK_STATE: Record<number, string> = {
  0: 'in_progress',
  1: 'completed',
  2: 'failed',
}

/** Cleaning robot mainState (§3.8 / §4.10) → normalized work state. */
export const KEENON_CLEAN_MAIN_STATE = {
  1: 'idle',
  2: 'operating',
  3: 'busy',
  4: 'charging',
  [-1]: 'offline',
} as const

export const KEENON_CLEAN_SUB_STATE: Record<number, string> = {
  11: 'Idle',
  21: 'In operation',
  30: 'Charging (default)',
  31: 'Matching charging pile',
  32: 'Charging',
  33: 'Off the pile',
  34: 'Line charging',
  40: 'Working (default)',
  41: 'Navigating',
  42: 'Cleaning',
  43: 'Self-cleaning',
  44: 'Returning',
  45: 'Cleaning paused',
  46: 'Return paused',
  47: 'Hand-push work',
  [-1]: 'Offline',
}

/** Callback bizTypes that are logged but don't change robot state in milestone 1. */
export const KEENON_IGNORED_TYPES = new Set([
  'RobotPositionType',
  'CleanRobotRechargeTask',
  'CleanRobotFinishTask',
  'CleanRobotPauseTask',
  'CleanStrategyTemporary',
  'AddCleanStrategy',
  'UpdateCleanStrategy',
  'DeleteCleanStrategy',
  'openAdapt',
])

// --- API response shapes (only the fields we use) ---------------------------

export interface KeenonStore {
  storeId: string
  storeName?: string
  customerName?: string
  brandName?: string
  address?: string
  country?: string
  province?: string
}

export interface KeenonRobot {
  robotId: string
  robotName?: string
  onlineStatus?: number
  power?: number
  robotModel?: string
  appVersion?: string
  city?: string
  onlineType?: number
}

export interface KeenonRobotStatus {
  robotId?: string
  onlineStatus?: boolean
  robotName?: string
  canBeCalled?: boolean
  chargeStatus?: number
  power?: number
  sceneCode?: string
  sceneName?: string
}
