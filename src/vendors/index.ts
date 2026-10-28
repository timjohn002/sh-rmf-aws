import type { ComponentType } from 'react'
import type { Robot } from '../types/api'
import { KeenonConfig } from './keenon/KeenonConfig'
import { KeenonRobotDetail } from './keenon/KeenonRobotDetail'

export interface VendorUi {
  /** The vendor's configuration page (each vendor's page can look completely different). */
  ConfigPage: ComponentType<{ vendorId: string }>
  /** Optional vendor-specific detail shown in a robot's row on the Robots page. */
  RobotDetail?: ComponentType<{ robot: Robot }>
}

/**
 * Browser-side pieces per vendor. Vendor ids must match the server registry
 * in server/vendors/index.ts, which owns names, capabilities and API logic.
 */
export const VENDOR_UI: Record<string, VendorUi> = {
  keenon: { ConfigPage: KeenonConfig, RobotDetail: KeenonRobotDetail },
}
