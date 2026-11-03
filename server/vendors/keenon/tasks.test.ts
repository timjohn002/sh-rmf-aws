import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canTakeTasks } from '../../../src/vendors/keenon/shared'
import type { KeenonRawPoint, KeenonTarget } from './api'
import { cachedTargets, callTaskBody, clearTargetCache, taskTargets } from './tasks'

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
