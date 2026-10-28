import { HttpError } from '../lib/http'
import { keenonAdapter } from './keenon/adapter'
import type { VendorAdapter } from './types'

/** Supported vendors. Adding a vendor = adding an adapter folder and registering it here. */
export const VENDORS: readonly VendorAdapter[] = [keenonAdapter]

export function findAdapter(id: string | undefined): VendorAdapter | undefined {
  return VENDORS.find((v) => v.id === id)
}

export function getAdapter(id: string | undefined): VendorAdapter {
  const adapter = findAdapter(id)
  if (!adapter) throw new HttpError(404, 'Unknown vendor')
  return adapter
}
