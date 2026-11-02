// Follow-up work for accepted Keenon callbacks (VendorAdapter.onCallback).
//
// Elevator riding (openAdapt, API doc 4.18): the robot reports each step as a callback, and
// we answer with separate calls to Keenon (POST /api/open/data/v2/elevator-to-device), not in
// the webhook reply. For now each step is only logged; the elevator (LiftMind) calls and the
// answers to Keenon go in the handlers below.

import { logJson } from '../../app'
import type { CallbackEvent, VendorConfigRow } from '../types'
import { ELEVATOR_EVENT_PREFIX, classifyKeenonCallback } from './webhook'

/** One elevator-riding callback (only the fields documented so far). */
export interface ElevatorStep {
  action: string
  taskNo: string | null
  messageId: number | null
  robotSn: string | null
  /** Action-specific fields, e.g. { dstId, sourceFloorNum, targetFloorNum } for QueryElevatorGroup. */
  data: Record<string, unknown>
}

export type ElevatorStepHandler = (step: ElevatorStep, config: VendorConfigRow) => Promise<void>

const text = (v: unknown): string | null =>
  typeof v === 'string' ? v.trim() || null : typeof v === 'number' ? String(v) : null

/** The elevator step in an openAdapt callback body, or null if it has no action. */
export function elevatorStep(body: unknown): ElevatorStep | null {
  const { data } = classifyKeenonCallback(body)
  const action = text(data.action)
  if (!action) return null
  const inner = data.data
  return {
    action,
    taskNo: text(data.taskNo),
    messageId: typeof data.messageId === 'number' ? data.messageId : null,
    robotSn: text(data.deviceName) ?? text(data.robotSn),
    data: inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {},
  }
}

const logStep: ElevatorStepHandler = async (step) => {
  logJson('info', 'elevator step received', {
    action: step.action,
    task_no: step.taskNo,
    robot: step.robotSn,
    data: step.data,
  })
}

/** Robot → elevator steps Keenon sends us, with the answer each one will need. */
export const ELEVATOR_STEP_HANDLERS: Record<string, ElevatorStepHandler> = {
  QueryElevatorGroup: logStep, // answer: RespondElevatorGroup
  RequestElevatorTask: logStep, // answer: RespondElevatorTask, then ReturnSchedulingResult (LiftMind ELEVATOR_REQUEST)
  ArriveWaitPoint: logStep, // answer: ArriveWaitPointAck
  RespondOpenDoorAck: logStep, // robot saw our RespondOpenDoor
  RobotMotionStatus: logStep, // inside/outside the car (LiftMind ENTERED_ELEVATOR / EXITED_ELEVATOR)
  ElevatorStatusAck: logStep, // robot saw our ElevatorStatus
  TerminateTask: logStep, // robot cancelled (LiftMind CANCEL_REQUEST)
}

export async function handleKeenonCallback(
  event: CallbackEvent,
  config: VendorConfigRow,
  handlers: Record<string, ElevatorStepHandler> = ELEVATOR_STEP_HANDLERS,
): Promise<void> {
  if (!event.eventType.startsWith(ELEVATOR_EVENT_PREFIX)) return
  const step = elevatorStep(event.body)
  if (!step) return
  const handler = handlers[step.action]
  if (!handler) {
    logJson('info', 'elevator step not handled', { action: step.action, task_no: step.taskNo, robot: step.robotSn })
    return
  }
  await handler(step, config)
}
