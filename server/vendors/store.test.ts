import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearConfigCache, getConfigCached } from './store'
import type { VendorConfigRow } from './types'

const row = (enabled: boolean) => ({ vendor: 'keenon', enabled }) as VendorConfigRow

describe('getConfigCached', () => {
  let clock = 0
  const now = () => clock

  beforeEach(() => {
    clearConfigCache()
    clock = 1_000_000
  })

  it('loads once, then answers from memory', async () => {
    const load = vi.fn(async () => row(true))
    expect(await getConfigCached('keenon', load, now)).toEqual(row(true))
    expect(await getConfigCached('keenon', load, now)).toEqual(row(true))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares one load between concurrent first calls', async () => {
    const load = vi.fn(async () => row(true))
    await Promise.all([getConfigCached('keenon', load, now), getConfigCached('keenon', load, now)])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('returns the old copy at once after 30 s and refreshes it in the background', async () => {
    const load = vi.fn(async () => row(true))
    await getConfigCached('keenon', load, now)

    clock += 31_000
    load.mockImplementation(async () => row(false))
    expect((await getConfigCached('keenon', load, now))?.enabled).toBe(true) // stale copy, no waiting
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect((await getConfigCached('keenon', load, now))?.enabled).toBe(false) // refreshed
  })

  it('keeps serving the old copy when a background refresh fails', async () => {
    const load = vi.fn(async () => row(true))
    await getConfigCached('keenon', load, now)

    clock += 31_000
    load.mockImplementation(async () => {
      throw new Error('db down')
    })
    expect((await getConfigCached('keenon', load, now))?.enabled).toBe(true)
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect((await getConfigCached('keenon', load, now))?.enabled).toBe(true)
  })

  it('remembers that a vendor has no config yet', async () => {
    const load = vi.fn(async () => null)
    expect(await getConfigCached('keenon', load, now)).toBeNull()
    expect(await getConfigCached('keenon', load, now)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
