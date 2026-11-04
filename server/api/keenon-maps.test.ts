import { describe, expect, it } from 'vitest'
import { mapHash } from './keenon-maps'

describe('mapHash (calibration fingerprint)', () => {
  const row = { map_png: 'iVBORw0KGgo', map_versions: ['b', 'a'] }

  it('is unchanged for floors whose points are not flipped (and rows from before the switch)', () => {
    const before = mapHash({ ...row, points_flipped: undefined as unknown as boolean })
    expect(mapHash({ ...row, points_flipped: false })).toBe(before)
  })

  it('changes when the points are flipped, so the calibration shows as out of date', () => {
    expect(mapHash({ ...row, points_flipped: true })).not.toBe(mapHash({ ...row, points_flipped: false }))
  })

  it('ignores the order of map versions', () => {
    expect(mapHash({ ...row, map_versions: ['a', 'b'], points_flipped: false })).toBe(mapHash({ ...row, points_flipped: false }))
  })
})
