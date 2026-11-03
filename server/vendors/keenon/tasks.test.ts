import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RobotTask } from '../../../src/types/api'
import { canTakeTasks } from '../../../src/vendors/keenon/shared'
import type { KeenonRawPoint, KeenonTarget } from './api'
import { KeenonError } from './client'
import {
  NO_RECORD_MESSAGE,
  cachedTargets,
  callTaskBody,
  clearTargetCache,
  isOpenRemoteCall,
  reconcileTask,
  taskTargets,
} from './tasks'

const target = (id: string, name: string, area: string | null = null): KeenonTarget => ({
  id,
  uuid: `uuid-${id}`,
  pointId: id,
  name,
  area,
})

describe('taskTargets', () => {
  const mapPoints: KeenonRawPoint[] = [
    { id: 12, name: 'Room 12', type: 'normal' },
    { id: 3, name: 'Room 3', type: 'Normal ' },
    { id: 7, name: 'Charging pile', type: 'charge' },
    { id: 9, name: 'Lobby', type: 'normal' }, // not in the target list
    { name: 'No id', type: 'normal' },
  ]
  const targets = [target('12', 'Room 12', 'Wing A'), target('3', 'Room 3'), target('7', 'Charging pile')]

  it('keeps only normal points, joined by id, sorted by name', () => {
    const { points, unmatched } = taskTargets(mapPoints, targets)
    expect(points).toEqual([
      { uuid: 'uuid-3', point_id: '3', name: 'Room 3', area: null },
      { uuid: 'uuid-12', point_id: '12', name: 'Room 12', area: 'Wing A' },
    ])
    expect(unmatched).toBe(1)
  })

  it('falls back to the target-list name', () => {
    const { points } = taskTargets([{ id: 3, name: ' ', type: 'normal' }], targets)
    expect(points[0].name).toBe('Room 3')
  })
})

describe('callTaskBody', () => {
  it('builds the v3 call body', () => {
    expect(
      callTaskBody({ point: { uuid: 'u-1', point_id: '12' }, storeId: 'S1', sceneCode: 'dhads6', robotSn: 'AA:BB' }),
    ).toEqual({ uuid: 'u-1', pointId: '12', storeId: 'S1', sceneCode: 'dhads6', robotId: 'AA:BB' })
  })
})

describe('cachedTargets', () => {
  beforeEach(clearTargetCache)

  it('reuses the target list for 10 minutes unless asked to refresh', async () => {
    const load = vi.fn(async () => [target('1', 'A')])
    await cachedTargets('s1', load, { now: 0 })
    await cachedTargets('s1', load, { now: 9 * 60_000 })
    expect(load).toHaveBeenCalledTimes(1)
    await cachedTargets('s1', load, { now: 11 * 60_000 })
    await cachedTargets('s1', load, { now: 11 * 60_000, refresh: true })
    expect(load).toHaveBeenCalledTimes(3)
  })
})

describe('canTakeTasks', () => {
  it.each([
    ['S100', true],
    ['KEENON S100', true],
    ['s100 pro', true],
    ['W3', false],
    ['C40', false],
    [null, false],
  ])('%s → %s', (model, expected) => {
    expect(canTakeTasks(model)).toBe(expected)
  })
})

describe('reconcileTask', () => {
  const NOW = new Date('2026-11-03T08:30:00Z')
  const open: RobotTask = {
    source: 'CreateTask',
    task_no: 'T-1',
    state: 'in_progress',
    type: 'Remote call',
    error_code: null,
    error_message: null,
    detail: { point_name: 'Room 201' },
    updated_at: '2026-11-03T07:45:23Z',
  }

  it('takes Keenon’s answer when the task finished', async () => {
    const task = await reconcileTask(open, 'SN-1', async () => ({ taskNo: 'T-1', taskStatus: 4, errorCode: 0, taskData: { robotId: 'SN-1' } }), NOW)
    expect(task).toMatchObject({ state: 'completed', task_no: 'T-1', type: 'Remote call', updated_at: NOW.toISOString() })
  })

  it('keeps a still-running task, with a fresh time', async () => {
    const task = await reconcileTask(open, 'SN-1', async () => ({ taskNo: 'T-1', taskStatus: 3 }), NOW)
    expect(task).toMatchObject({ state: 'in_progress', updated_at: NOW.toISOString() })
  })

  it('ends a task Keenon no longer knows (no data, or a parameter error)', async () => {
    expect(await reconcileTask(open, 'SN-1', async () => null, NOW)).toMatchObject({ state: 'ended', error_message: NO_RECORD_MESSAGE })
    const unknown = async () => {
      throw new KeenonError(610601, 'Keenon rejected the request parameters.')
    }
    expect(await reconcileTask(open, 'SN-1', unknown, NOW)).toMatchObject({ state: 'ended' })
  })

  it('passes other Keenon errors on, changing nothing', async () => {
    const blocked = async () => {
      throw new KeenonError(617000, 'IP not whitelisted')
    }
    await expect(reconcileTask(open, 'SN-1', blocked, NOW)).rejects.toThrow(/whitelisted/)
  })

  it('leaves finished tasks and non-remote tasks alone', async () => {
    const query = vi.fn(async () => ({ taskStatus: 4 }))
    expect(await reconcileTask({ ...open, state: 'completed' }, 'SN-1', query)).toBeNull()
    expect(await reconcileTask({ ...open, state: 'ended' }, 'SN-1', query)).toBeNull()
    expect(await reconcileTask({ ...open, type: 'Hotel delivery' }, 'SN-1', query)).toBeNull()
    expect(await reconcileTask(null, 'SN-1', query)).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it('isOpenRemoteCall', () => {
    expect(isOpenRemoteCall(open)).toBe(true)
    expect(isOpenRemoteCall({ ...open, state: 'cancelled' })).toBe(false)
    expect(isOpenRemoteCall({ ...open, task_no: null })).toBe(false)
  })
})
