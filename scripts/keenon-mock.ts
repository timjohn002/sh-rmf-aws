// A tiny fake Keenon Cloud for local testing (no credentials or IP whitelist needed).
//
//   npm run keenon:mock            → http://localhost:4010
//
// In Vendors → Keenon choose Region "Custom URL" = http://localhost:4010,
// Client ID "mock-client", Client secret "mock-secret".
// "Runner 1" is an S100 with two floors of points, for trying Send task (Robots page).

import { createServer } from 'node:http'

const PORT = Number(process.env.KEENON_MOCK_PORT ?? 4010)
const CLIENT_ID = 'mock-client'
const CLIENT_SECRET = 'mock-secret'
const TOKEN = 'mock-token-' + Math.random().toString(36).slice(2)

const stores = [
  { storeId: 'S00000001', storeName: 'Mock Hotel', brandName: 'Starhub', address: '1 Test Road', country: 'Singapore' },
  { storeId: 'S00000002', storeName: 'Mock Restaurant', brandName: 'Starhub', address: '2 Test Road', country: 'Singapore' },
]

const robots: Record<string, object[]> = {
  S00000001: [
    { robotId: 'AA:BB:CC:00:00:01', robotName: 'Butler 1', onlineStatus: 1, power: 82, robotModel: 'W3', appVersion: 'v1.15.0', onlineType: 2 },
    { robotId: '2C:C3:E6:E8:33:78', robotName: 'Cleaner 1', onlineStatus: 1, power: 64, robotModel: 'C40', appVersion: 'v3.6.0', onlineType: 4 },
    { robotId: 'AA:BB:CC:00:01:00', robotName: 'Runner 1', onlineStatus: 1, power: 90, robotModel: 'S100', appVersion: 'v1.10.0', onlineType: 2 },
  ],
  S00000002: [
    { robotId: 'AA:BB:CC:00:00:02', robotName: 'Server 1', onlineStatus: 0, power: 12, robotModel: 'T8', appVersion: 'v1.8.0', onlineType: 2 },
  ],
}

const ok = (data: unknown) => ({ code: 610000, msg: 'Request successful', data })

// Scene dhads6: map points per floor (map/position, with type) and the target list (uuid/pointId,
// no type). Both share the point id. Only "normal" points can be sent to.
const mapPoints: Record<number, { id: number; name: string; type: string }[]> = {
  1: [
    { id: 101, name: 'Lobby', type: 'normal' },
    { id: 102, name: 'Reception', type: 'normal' },
    { id: 103, name: 'Charging pile', type: 'charge' },
  ],
  2: [
    { id: 201, name: 'Room 201', type: 'normal' },
    { id: 202, name: 'Room 202', type: 'normal' },
    { id: 203, name: 'Lift lobby L2', type: 'elevator' },
    { id: 204, name: 'Pantry', type: 'normal' }, // missing from the target list on purpose
  ],
}
const targets = Object.values(mapPoints)
  .flat()
  .filter((p) => p.id !== 204)
  .map((p) => ({ id: p.id, pointName: p.name, area: p.id < 200 ? 'Ground' : 'Level 2', uuid: `uuid-${p.id}`, pointId: String(p.id) }))
const tasks = new Map<string, { robotId: string; uuid: string }>()

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  let body = ''
  for await (const chunk of req) body += chunk
  const send = (payload: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  console.log(req.method, url.pathname + url.search)

  if (url.pathname === '/api/open/oauth/token') {
    const form = new URLSearchParams(body)
    if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
      return send({ code: 610001, msg: 'Wrong user name or password' }, 401)
    }
    if (form.get('grant_type') !== 'client_credentials') return send({ code: 610601, msg: 'grant_type' }, 400)
    return send({ access_token: TOKEN, token_type: 'bearer', expires_in: 7200, scope: 'all' })
  }

  if (req.headers.authorization !== `bearer ${TOKEN}`) return send({ code: 610401, msg: 'Token verification failed' })

  switch (url.pathname) {
    case '/api/open/data/v1/store/list':
      return send(ok(stores))
    case '/api/open/data/v1/store/robot/list':
      return send(ok(robots[url.searchParams.get('storeId') ?? ''] ?? []))
    case '/api/open/scene/v1/robot/status': {
      const id = url.searchParams.get('robotId')
      const robot = Object.values(robots).flat().find((r) => (r as { robotId: string }).robotId === id) as
        | { robotId: string; robotName: string; onlineStatus: number; power: number }
        | undefined
      if (!robot || robot.robotId.startsWith('2C:')) return send({ code: 610601, msg: 'Request parameter exception' })
      return send(
        ok({
          list: [
            {
              robotId: robot.robotId,
              robotName: robot.robotName,
              onlineStatus: robot.onlineStatus === 1,
              canBeCalled: robot.onlineStatus === 1,
              chargeStatus: -1,
              power: robot.power,
              sceneCode: 'dhads6',
              sceneName: 'Default scene',
            },
          ],
        }),
      )
    }
    case '/api/open/custom/clean/robot/status':
      return send(
        ok({
          robotSn: url.searchParams.get('robotSn'),
          mainState: 3,
          subState: 42,
          globalState: { rosConnect: true, faulting: false, scram: false },
          hardwareState: { dustBag: 1, cleanWaterTank: 2 },
          childState: { lifting: false, navigating: true },
        }),
      )
    case '/api/open/custom/robot/battery/level':
      return send(ok({ batteryLevel: 63 }))
    case '/api/open/custom/robot/map/position': {
      const floor = Number(url.searchParams.get('floorInfo'))
      const points = url.searchParams.get('sceneCode') === 'dhads6' ? (mapPoints[floor] ?? []) : []
      return send(ok({ targetList: points.map((p) => ({ ...p, targetId: p.id, floor, floorInfo: `L${floor}`, mapMd5: 'mock' })) }))
    }
    case '/api/open/custom/robot/location':
      return send(ok({ coordinate: '1.5,2.5,0', floor: 2, lastReportTimestamp: Date.now() }))
    case '/api/open/scene/v1/target/list':
      return send(ok({ list: url.searchParams.get('sceneCode') === 'dhads6' ? targets : [] }))
    case '/api/open/scene/v3/robot/call/task': {
      if (req.method === 'POST') {
        const call = JSON.parse(body || '{}') as { uuid?: string; pointId?: string; robotId?: string; storeId?: string }
        if (!targets.some((t) => t.uuid === call.uuid && t.pointId === call.pointId)) {
          return send({ code: 610601, msg: 'Unknown point' })
        }
        const taskNo = Math.random().toString(16).slice(2, 18)
        tasks.set(taskNo, { robotId: call.robotId ?? '', uuid: call.uuid ?? '' })
        console.log(`  → task ${taskNo}: ${call.robotId} to ${call.uuid}`)
        return send(ok({ taskNo, waitQueuing: 1 }))
      }
      return send({ code: 610601, msg: 'Use POST' }, 405)
    }
    case '/api/open/scene/v1/robot/call/task': {
      if (req.method === 'GET') {
        // Task status query; like Keenon, an unknown task is a parameter error.
        const taskNo = url.searchParams.get('taskNo') ?? ''
        const task = tasks.get(taskNo)
        if (!task) return send({ code: 610601, msg: 'Request parameter exception' })
        return send(ok({ taskNo, taskStatus: 3, errorCode: 0, taskData: { robotId: task.robotId, remainingDistance: 4.2 } }))
      }
      if (req.method === 'DELETE') {
        const taskNo = url.searchParams.get('taskNo') ?? ''
        if (!tasks.delete(taskNo)) return send({ code: 610601, msg: 'Task not found' })
        console.log(`  → task ${taskNo} cancelled`)
        return send({ code: 610000, msg: 'Request successful' })
      }
      return send({ code: 610601, msg: 'Use DELETE' }, 405)
    }
    default:
      return send({ code: 610601, msg: `Mock has no ${url.pathname}` }, 404)
  }
})

server.listen(PORT, () => console.log(`Mock Keenon Cloud on http://localhost:${PORT}`))
