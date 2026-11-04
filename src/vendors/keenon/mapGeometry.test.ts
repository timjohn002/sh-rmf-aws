import { describe, expect, it } from 'vitest'
import { pixelToWorld, worldToPixel } from '../../lib/coords'
import {
  keenonMapCalibration,
  mapPixelToImage,
  mapPixelToMeters,
  metersToMapPixel,
  namedPointToMeters,
  pointsLookFlipped,
} from './mapGeometry'

// Real data, scene 489rAM floor 2 (2026-10-07).
const FLOOR2 = { map_width: 480, map_height: 476, origin_x_m: -12.75, origin_y_m: -12.550000190734863 }
const CHARGING_PILE = { x: 243.08897293414097, y: 225.18616590909548 } // map pixels
const DOCKED_C40 = { x: -1.47, y: -1.26 } // metres, reported while charging

describe('Keenon map geometry', () => {
  it('puts the docked C40 within 1 m of its charging pile', () => {
    const pile = mapPixelToMeters(FLOOR2, CHARGING_PILE)
    expect(Math.hypot(pile.x - DOCKED_C40.x, pile.y - DOCKED_C40.y)).toBeLessThan(1)
  })

  it('round-trips metres and map pixels', () => {
    const back = mapPixelToMeters(FLOOR2, metersToMapPixel(FLOOR2, DOCKED_C40))
    expect(back.x).toBeCloseTo(DOCKED_C40.x)
    expect(back.y).toBeCloseTo(DOCKED_C40.y)
  })

  it('flips y for the image (origin is bottom-left)', () => {
    expect(mapPixelToImage(FLOOR2, { x: 10, y: 0 })).toEqual({ x: 10, y: 476 })
    expect(mapPixelToImage(FLOOR2, { x: 10, y: 476 })).toEqual({ x: 10, y: 0 })
  })

  it("gives PlanMap a calibration whose world frame is the robot's frame", () => {
    const cal = keenonMapCalibration(FLOOR2)
    // A named point: map pixels → metres → image pixels must equal the y-flipped point.
    const metres = mapPixelToMeters(FLOOR2, CHARGING_PILE)
    const image = worldToPixel(metres, cal)
    const expected = mapPixelToImage(FLOOR2, CHARGING_PILE)
    expect(image.x).toBeCloseTo(expected.x)
    expect(image.y).toBeCloseTo(expected.y)
    // And the cursor readout (image pixel → world) gives robot metres back.
    const readout = pixelToWorld(image, cal)
    expect(readout.x).toBeCloseTo(metres.x)
    expect(readout.y).toBeCloseTo(metres.y)
  })
})

// Real data, S100 scene gQqYpw floor 1 (2026-11-04): points measured from the top of the image.
const S100_FLOOR1 = {
  map_width: 517,
  map_height: 561,
  origin_x_m: -17.6499996185303,
  origin_y_m: -17.6000003814697,
  align_offset_x_m: -9.62603066352811,
  align_offset_y_m: -7.28838164942681,
  points: [
    { name: '1_Charging pile', type: 'charge', x_px: 179.02908934227636, y_px: 344.50031155152874 },
    { name: 'origin', type: 'origin', x_px: 173.90754042188655, y_px: 350.19203330015364 },
    { name: 'L1 Point', type: 'normal', x_px: 199.17021359073863, y_px: 309.8750029424899 },
  ],
}

// Real data, C40 scene 489rAM floor 2: points measured up from the origin (no flip).
const C40_FLOOR2 = {
  ...FLOOR2,
  align_offset_x_m: -1.37812328430276,
  align_offset_y_m: -1.44566658666822,
  points: [{ name: '2_Charging pile', type: 'charge', x_px: CHARGING_PILE.x, y_px: CHARGING_PILE.y }],
}

describe('named points measured from the top (points_flipped)', () => {
  it('reads y from the top of the image when the floor is flipped', () => {
    const p = { x: 179, y: 344.5 }
    expect(namedPointToMeters({ ...S100_FLOOR1, points_flipped: false }, p)).toEqual(mapPixelToMeters(S100_FLOOR1, p))
    const flipped = namedPointToMeters({ ...S100_FLOOR1, points_flipped: true }, p)
    expect(flipped.x).toBeCloseTo(mapPixelToMeters(S100_FLOOR1, p).x)
    expect(flipped.y).toBeCloseTo(S100_FLOOR1.origin_y_m + (561 - 344.5) * 0.05)
  })

  it('suggests flipping the S100 floor, whose charging pile is ~7 m from the robot’s aligned home', () => {
    expect(pointsLookFlipped({ ...S100_FLOOR1, points_flipped: false })).toBe(true)
    expect(pointsLookFlipped({ ...S100_FLOOR1, points_flipped: true })).toBe(false)
  })

  it('does not suggest it for the C40 floor', () => {
    expect(pointsLookFlipped({ ...C40_FLOOR2, points_flipped: false })).toBe(false)
  })

  it('needs an alignment and a home point', () => {
    expect(pointsLookFlipped({ ...S100_FLOOR1, align_offset_x_m: null, align_offset_y_m: null })).toBe(false)
    expect(pointsLookFlipped({ ...S100_FLOOR1, points: S100_FLOOR1.points.filter((p) => p.type === 'normal') })).toBe(false)
  })
})
