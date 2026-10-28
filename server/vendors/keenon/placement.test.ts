import { describe, expect, it } from 'vitest'
import type { RobotPosition } from '../../../src/types/api'
import { hasReadyFloor, placeKeenonRobot, type PlacementFloor } from './placement'

const SCENE = '489rAM'

/** Floor 2 of the C40: aligned with the numbers from the user's notes, calibrated at 20 px/m. */
function floor(patch: Partial<PlacementFloor> = {}): PlacementFloor {
  return {
    scene_code: SCENE,
    floor: 2,
    app_floor_id: 'app-floor-2',
    align_rotation_rad: Math.PI,
    align_offset_x_m: -1.47,
    align_offset_y_m: -1.26,
    align_mirror: false,
    calib_scale_px_per_m: 20,
    calib_rotation_rad: 0,
    calib_origin_x_px: 500,
    calib_origin_y_px: 400,
    ...patch,
  }
}

function position(patch: Partial<RobotPosition> = {}): RobotPosition {
  return { floor: '2', x: -1.5, y: -1.3, heading_rad: 0, reported_at: null, source: 'keenon:location', ...patch }
}

describe('placeKeenonRobot', () => {
  it('composes alignment then calibration (C40 numbers)', () => {
    const placed = placeKeenonRobot(position(), SCENE, [floor()])
    if ('reason' in placed) throw new Error(placed.reason)
    // reported (−1.50, −1.30) → map (0.03, 0.04) → plan (500 + 0.6, 400 − 0.8)
    expect(placed.floor_id).toBe('app-floor-2')
    expect(placed.x_px).toBeCloseTo(500.6, 6)
    expect(placed.y_px).toBeCloseTo(399.2, 6)
    // Heading 0 in the reported frame points along −x on the map after the 180° alignment.
    expect(placed.heading_rad).toBeCloseTo(Math.PI, 6)
  })

  it('picks the floor the robot reports, within its current scene', () => {
    const floors = [
      floor({ floor: 1, app_floor_id: 'app-floor-1', calib_origin_x_px: 0 }),
      floor(),
      floor({ scene_code: 'old', floor: 2, app_floor_id: 'elsewhere' }),
    ]
    const placed = placeKeenonRobot(position(), SCENE, floors)
    expect('floor_id' in placed && placed.floor_id).toBe('app-floor-2')
  })

  it.each([
    ['no scene', position(), null, [floor()], /scene is unknown/],
    ['no floors in scene', position(), SCENE, [floor({ scene_code: 'other' })], /no floors found/],
    ['no position', null, SCENE, [floor()], /no position yet/],
    ['no position, nothing set up', null, SCENE, [floor({ app_floor_id: null })], /none of its floors is set up/],
    ['floor not in scene', position({ floor: '3' }), SCENE, [floor()], /floor 3, which isn't in its scene/],
    ['not matched', position(), SCENE, [floor({ app_floor_id: null })], /isn't matched/],
    ['not aligned', position(), SCENE, [floor({ align_rotation_rad: null })], /isn't aligned/],
    ['not calibrated', position(), SCENE, [floor({ calib_scale_px_per_m: null })], /isn't calibrated/],
  ] as const)('explains why it cannot place: %s', (_name, pos, scene, floors, reason) => {
    const placed = placeKeenonRobot(pos, scene, [...floors])
    expect('reason' in placed && placed.reason).toMatch(reason)
  })
})

describe('hasReadyFloor', () => {
  it('needs a matched, aligned and calibrated floor in the current scene', () => {
    expect(hasReadyFloor(SCENE, [floor()])).toBe(true)
    expect(hasReadyFloor(SCENE, [floor({ align_offset_x_m: null })])).toBe(false)
    expect(hasReadyFloor(SCENE, [floor({ scene_code: 'old' })])).toBe(false)
    expect(hasReadyFloor(null, [floor()])).toBe(false)
  })
})
