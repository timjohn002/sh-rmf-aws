import { describe, expect, it, vi } from 'vitest'
import { fetchStoreRobots, keenonOnline } from './adapter'
import { KeenonClient } from './client'

// Real `store/robot/list` response captured from Keenon Cloud on 2026-10-07.
const REAL_ROBOT_LIST = {
  code: 610000,
  msg: 'Request successful',
  data: [
    {
      robotId: '88:49:2D:A0:4D:29',
      robotCode: 'cdd88bc0f00d2d5d04b400caa88b4b90',
      mftCode: 'QC402511DW0003',
      robotName: 'C40',
      onlineStatus: 1,
      power: 95,
      robotModel: 'C40 S',
      appVersion: 'v3.7.0-0-g1357cf2',
      city: '56 Kallang Pudding Road Singapore 349328 Kallang Pudding Rd, Singapore 349328',
      onlineType: 2,
    },
  ],
}

describe('keenonOnline', () => {
  it('accepts both 1/0 and true/false', () => {
    expect(keenonOnline(1)).toBe(true)
    expect(keenonOnline(true)).toBe(true)
    expect(keenonOnline('1')).toBe(true)
    expect(keenonOnline(0)).toBe(false)
    expect(keenonOnline(false)).toBe(false)
    expect(keenonOnline(undefined)).toBeNull()
    expect(keenonOnline(7)).toBeNull()
  })
})

describe('fetchStoreRobots', () => {
  it('reads online status from the robot list (real response)', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response(JSON.stringify(REAL_ROBOT_LIST))
    }) as unknown as typeof fetch
    const client = new KeenonClient({
      baseUrl: 'https://keenon.test',
      clientId: 'id',
      clientSecret: 'secret',
      cachedToken: { token: 'tok', expiresAt: new Date(Date.now() + 3_600_000) },
      fetchImpl,
    })

    const robots = await fetchStoreRobots(client, ['C00716282'])

    expect(urls).toEqual(['https://keenon.test/api/open/data/v1/store/robot/list?storeId=C00716282'])
    expect(robots).toEqual([
      {
        external_id: '88:49:2D:A0:4D:29',
        store_external_id: 'C00716282',
        name: 'C40',
        model: 'C40 S',
        app_version: 'v3.7.0-0-g1357cf2',
        online: true,
        online_type: 'Wi-Fi',
        battery: 95,
      },
    ])
  })
})
