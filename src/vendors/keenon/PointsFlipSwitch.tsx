import { ErrorBox, Toggle, errorMessage } from '../../components/ui'
import { pointsLookFlipped } from './mapGeometry'
import type { KeenonRobotFloor } from './shared'
import { useSetPointsFlipped } from './useKeenonMaps'

/**
 * "Named points are upside down" switch for one Keenon floor, with a hint when the floor's home
 * point (charging pile / origin) is far from where the alignment puts the robot's home.
 */
export function PointsFlipSwitch({ robotId, floor }: { robotId: string; floor: KeenonRobotFloor }) {
  const save = useSetPointsFlipped(robotId)
  const suggest = floor.map_height !== null && floor.origin_x_m !== null && floor.origin_y_m !== null &&
    pointsLookFlipped({ ...floor, map_height: floor.map_height, origin_x_m: floor.origin_x_m, origin_y_m: floor.origin_y_m })
  const set = (flipped: boolean) => save.mutate({ floorId: floor.id, flipped })

  return (
    <div className="space-y-2">
      <Toggle
        checked={floor.points_flipped}
        disabled={save.isPending}
        onChange={set}
        label="Named points are upside down"
        description="Some robots' maps (seen on the S100) measure named points from the top of the image. A calibration made with the other setting shows as out of date; redo its pairs."
      />
      {suggest && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="flex-1">
            The charging pile / origin point is far from where the robot's home is. This floor's named points may be
            {floor.points_flipped ? ' the right way up after all.' : ' upside down.'}
          </span>
          <button
            type="button"
            className="rounded-md bg-amber-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            disabled={save.isPending}
            onClick={() => set(!floor.points_flipped)}
          >
            {floor.points_flipped ? 'Flip back' : 'Flip points'}
          </button>
        </div>
      )}
      {save.error && <ErrorBox>{errorMessage(save.error)}</ErrorBox>}
    </div>
  )
}
