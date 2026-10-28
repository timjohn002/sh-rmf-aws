import type { z } from 'zod'
import type { RobotPosition, RobotTask, SignatureStatus, VendorStore, VendorTestResult, WorkState } from '../../src/types/api'

/** A `vendor_configs` row. `secrets` must never leave the server. */
export interface VendorConfigRow {
  vendor: string
  enabled: boolean
  settings: Record<string, unknown>
  secrets: Record<string, string>
  webhook_token: string
  access_token: string | null
  token_expires_at: string | null
  last_sync_at: string | null
  last_sync_error: string | null
  last_callback_at: string | null
  updated_at: string
}

/** Fields a vendor may set on a `robots` row. Omitted fields are left unchanged. */
export interface RobotPatch {
  store_external_id?: string | null
  name?: string | null
  model?: string | null
  app_version?: string | null
  online?: boolean | null
  online_type?: string | null
  battery?: number | null
  charging?: boolean | null
  work_state?: WorkState
  can_be_called?: boolean | null
  current_task?: RobotTask | null
  vendor_status?: Record<string, unknown> | null
}

export interface SyncedRobot extends RobotPatch {
  external_id: string
}

export type SyncedStore = Omit<VendorStore, 'synced_at'>

export interface SyncData {
  stores: SyncedStore[]
  robots: SyncedRobot[]
}

export interface SignatureCheck {
  status: SignatureStatus
  detail?: string
}

/** What a vendor callback means, independent of how it is stored. */
export interface WebhookInterpretation {
  eventType: string
  robotExternalId: string | null
  patch: RobotPatch | null
  status: 'processed' | 'ignored'
  note?: string
}

/** Everything an adapter needs to call the vendor's API. */
export interface VendorContext {
  config: VendorConfigRow
  /** Persist a fresh API token so other function invocations can reuse it. */
  saveToken(token: string, expiresAt: Date): Promise<void>
}

/** A `robots` row as the Map page needs it. */
export interface MapRobotRow {
  id: string
  vendor: string
  external_id: string
  name: string | null
  model: string | null
  online: boolean | null
  /** Raw, in the vendor's frame. */
  position: RobotPosition | null
}

/** Where a robot goes on the app's floor plans, or why it can't be drawn. */
export type RobotPlacement =
  | { floor_id: string; x_px: number; y_px: number; heading_rad: number | null }
  | { reason: string }

/** A vendor's floor setup for some robots, loaded once per Map request. */
export interface MapPlacer {
  /** Worth asking the vendor where it is (e.g. set up on at least one floor, not offline). */
  isLocatable(robot: MapRobotRow): boolean
  /** Place a robot (with its latest position) on an app floor. */
  place(robot: MapRobotRow): RobotPlacement
}

/** Live robot positions on the app's floor plans (Map page). */
export interface MapPositionsCapability {
  /** A stored position older than this is fetched again. */
  refreshAfterMs: number
  /** Load the vendor's floor setup for these robots. */
  prepare(robots: MapRobotRow[]): Promise<MapPlacer>
  /** Current raw positions by robot id. Throws VendorApiError when the vendor can't be reached. */
  locate(ctx: VendorContext, robots: MapRobotRow[]): Promise<Map<string, RobotPosition>>
}

export interface VendorAdapter {
  id: string
  name: string
  description: string
  /** Parses stored settings, filling defaults. */
  settingsSchema: z.ZodType<Record<string, unknown>>
  secretFields: readonly string[]
  /** Enough settings + secrets to call the vendor API. */
  isConfigured(config: VendorConfigRow): boolean
  /** Settings keys whose change invalidates the cached API token. */
  credentialSettings: readonly string[]
  /** What the Robots page may do with this vendor's robots. */
  robotCapabilities: {
    /** Vendor-level on-demand status pull (`refreshRobots`). */
    refresh: boolean
    /** Minimum gap between refreshes of this vendor's robots (vendor rate limits). */
    refreshCooldownMs: number
  }

  testConnection(ctx: VendorContext): Promise<VendorTestResult>
  fetchSyncData(ctx: VendorContext): Promise<SyncData>
  /** Current status of all of this vendor's robots in scope (Robots page "Refresh"). */
  refreshRobots(ctx: VendorContext): Promise<SyncedRobot[]>

  verifyWebhook(config: VendorConfigRow, rawBody: string, headers: Headers): SignatureCheck
  requireSignature(config: VendorConfigRow): boolean
  interpretWebhook(body: unknown): WebhookInterpretation
  /** Body to reply to the vendor with after a callback is accepted. */
  webhookAck: unknown

  /** Robots on the Map page. Vendors without it don't appear there. */
  mapPositions?: MapPositionsCapability
}
