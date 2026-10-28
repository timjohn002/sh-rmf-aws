import { describe, expect, it, vi } from 'vitest'
import { parseKeenonLocation } from './api'
import { KeenonClient } from './client'
import { discoverRobotMaps, mergeFloorSources, toMapPoint } from './mapDiscovery'

describe('parseKeenonLocation', () => {
  it('parses a real response, including a null heading', () => {
    // Real data, 2026-10-07.
    expect(
      parseKeenonLocation({
        building: '',
        floor: '1',
        coordinate: '0.44,2.72,null',
        takeElevatorStatus: 0,
        lastReportTimestamp: 1791367444123,
      }),
    ).toEqual({
      floor: '1',
      building: null,
      x: 0.44,
      y: 2.72,
      heading_rad: null,
      reported_at: new Date(1791367444123).toISOString(),
      take_elevator: 0,
    })
    expect(parseKeenonLocation({ floor: '2', coordinate: '-1.47,-1.26,-0.07' })).toMatchObject({
      x: -1.47,
      y: -1.26,
      heading_rad: -0.07,
    })
  })

  it('rejects unusable coordinates', () => {
    expect(parseKeenonLocation({ coordinate: '' })).toBeNull()
    expect(parseKeenonLocation({ coordinate: 'null,null,null' })).toBeNull()
    expect(parseKeenonLocation(null)).toBeNull()
  })
})

describe('mergeFloorSources', () => {
  it('combines and sorts floors, recording every source', () => {
    const merged = mergeFloorSources({ location: [2], 'clean-areas': [1, 2], points: [2, 1, 3] })
    expect([...merged.entries()]).toEqual([
      [1, ['clean-areas', 'points']],
      [2, ['location', 'clean-areas', 'points']],
      [3, ['points']],
    ])
  })
})

describe('toMapPoint', () => {
  it('maps a real point and skips points without coordinates', () => {
    expect(
      toMapPoint({
        id: 1,
        targetId: 1,
        name: '2_Charging pile',
        type: 'charge',
        floor: 2,
        mapMd5: 'c84d88838991c5f07c26f370d3cfd609',
        positionX: 243.08897293414097,
        positionY: 225.18616590909548,
        floorInfo: 'Office',
        buildingInfo: 'A',
      }),
    ).toEqual({
      id: 1,
      name: '2_Charging pile',
      type: 'charge',
      x_px: 243.08897293414097,
      y_px: 225.18616590909548,
      map_md5: 'c84d88838991c5f07c26f370d3cfd609',
      floor_label: 'Office',
      building: 'A',
    })
    expect(toMapPoint({ name: 'no coords' })).toBeNull()
  })
})

describe('discoverRobotMaps', () => {
  /** Fake Keenon answering like the real 489rAM scene: points on floors 1 and 2. */
  function fakeKeenon() {
    const calls: string[] = []
    const ok = (data: unknown) => new Response(JSON.stringify({ code: 610000, msg: 'success', data }))
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      calls.push(url.pathname + url.search)
      const floor = Number(url.searchParams.get('floorInfo'))
      switch (url.pathname) {
        case '/api/open/scene/v1/robot/status':
          return ok({ robotId: 'R1', sceneCode: '489rAM', sceneName: 'C40_corridor', onlineStatus: false })
        case '/api/open/custom/robot/location':
          return new Response(
            JSON.stringify({ code: 200, status: 0, data: { floor: '2', coordinate: '-1.47,-1.26,-0.07' } }),
          )
        case '/api/open/custom/clean/robot/area/list':
          return ok({ entities: [{ mapId: 'a', floor: 1 }, { mapId: 'b', floor: 2 }] })
        case '/api/open/custom/robot/map/position':
          return ok({
            targetList:
              floor === 1 || floor === 2
                ? [{ targetId: floor, name: `P${floor}`, positionX: 10, positionY: 20, mapMd5: `md5-${floor}` }]
                : [],
          })
        case '/api/open/custom/robot/map':
          return ok({
            content: 'iVBORw0KGgo=',
            originPosition: { isDynamic: true, width: 480, height: 476, originX: -12.75, originY: -12.55 },
          })
        default:
          return ok(null)
      }
    }) as unknown as typeof fetch
    const client = new KeenonClient({
      baseUrl: 'https://keenon.test',
      clientId: 'id',
      clientSecret: 'secret',
      cachedToken: { token: 't', expiresAt: new Date(Date.now() + 3_600_000) },
      fetchImpl,
    })
    return { client, calls }
  }

  it('detects the scene and finds floors from every source', async () => {
    const { client } = fakeKeenon()
    const result = await discoverRobotMaps(client, { external_id: 'R1', store_external_id: 'S1' }, null)

    expect(result.scene).toEqual({ code: '489rAM', name: 'C40_corridor', source: 'detected' })
    expect(result.position).toMatchObject({ floor: '2', x: -1.47, y: -1.26, source: 'keenon:location' })
    expect(result.floors.map((f) => [f.floor, f.sources])).toEqual([
      [1, ['clean-areas', 'points']],
      [2, ['location', 'clean-areas', 'points']],
    ])
    expect(result.floors[1]).toMatchObject({
      map_png: 'iVBORw0KGgo=',
      map_width: 480,
      map_height: 476,
      origin_x_m: -12.75,
      map_versions: ['md5-2'],
    })
    // The fake returns one image for every floor, as Keenon did for scene wf4bzY.
    expect(result.warnings).toContain(
      'Floors 1 and 2 returned the same map image; Keenon may not have a separate map for each',
    )
  })

  it('uses the manual scene instead of asking the robot', async () => {
    const { client, calls } = fakeKeenon()
    const result = await discoverRobotMaps(client, { external_id: 'R1', store_external_id: null }, {
      code: 'MANUAL',
      name: 'Picked',
    })
    expect(result.scene).toEqual({ code: 'MANUAL', name: 'Picked', source: 'manual' })
    expect(calls.some((c) => c.startsWith('/api/open/scene/v1/robot/status'))).toBe(false)
    expect(calls.some((c) => c.includes('sceneCode=MANUAL'))).toBe(true)
  })
})
