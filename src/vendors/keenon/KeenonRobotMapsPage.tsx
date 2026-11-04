import { useState } from 'react'
import { CircleMarker, Tooltip } from 'react-leaflet'
import { Link, useParams } from 'react-router-dom'
import { PlanMap } from '../../components/map/PlanMap'
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  FullPageSpinner,
  SelectField,
  Spinner,
  errorMessage,
} from '../../components/ui'
import { useFloors } from '../../hooks/useFloors'
import { formatMeters, pixelToLatLng, worldToPixel, type Point } from '../../lib/coords'
import { formatDateTime, timeAgo } from '../../lib/format'
import type { Floor } from '../../types/api'
import { alignedRobot, floorAlignment } from './floorTransforms'
import { keenonMapCalibration, namedPointToMeters } from './mapGeometry'
import { PointsFlipSwitch } from './PointsFlipSwitch'
import { KEENON_MAP_RESOLUTION, type KeenonRobotFloor, type KeenonRobotMapsDetail } from './shared'
import {
  useDiscoverRobotMaps,
  useKeenonRobotMaps,
  useMatchFloor,
  useSetRobotScene,
  useStoreScenes,
} from './useKeenonMaps'

const SOURCE_LABEL: Record<string, string> = {
  points: 'named points',
  'clean-areas': 'cleaning areas',
  location: "robot's current floor",
}

/** `/vendors/keenon/robots/:robotId`: discover a robot's floors and match them to app floor plans. */
export function KeenonRobotMapsPage() {
  const { robotId = '' } = useParams()
  const { data, isPending, error } = useKeenonRobotMaps(robotId)
  const discover = useDiscoverRobotMaps(robotId)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
        <Link to="/vendors/keenon" className="text-sm text-blue-600 hover:underline">
          ← Keenon
        </Link>
        {isPending ? (
          <FullPageSpinner />
        ) : error ? (
          <ErrorBox title="Could not load this robot">{errorMessage(error)}</ErrorBox>
        ) : (
          <>
            <RobotHeader detail={data} discovering={discover.isPending} onDiscover={() => discover.mutate()} />
            {discover.error && <ErrorBox title="Discovery failed">{errorMessage(discover.error)}</ErrorBox>}
            <Floors detail={data} />
          </>
        )}
      </div>
    </div>
  )
}

function RobotHeader({
  detail,
  discovering,
  onDiscover,
}: {
  detail: KeenonRobotMapsDetail
  discovering: boolean
  onDiscover: () => void
}) {
  const { robot, position } = detail
  return (
    <Card
      title={robot.name ?? robot.external_id}
      description={
        <>
          <span className="font-mono">{robot.external_id}</span>
          {robot.model && ` · ${robot.model}`}
          {` · Store ${robot.store_name ?? robot.store_external_id ?? 'unknown'}`}
        </>
      }
      actions={
        <Button onClick={onDiscover} disabled={discovering}>
          {discovering ? 'Discovering…' : robot.floors_found ? 'Re-discover floors' : 'Discover floors'}
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <SceneControl detail={detail} />
        <div className="text-sm">
          <p className="font-medium text-slate-700">Last reported position</p>
          {position ? (
            <p className="text-slate-600">
              Floor {position.floor ?? '?'} · x {formatMeters(position.x)}, y {formatMeters(position.y)}
              {position.heading_rad !== null && ` · heading ${Math.round((position.heading_rad * 180) / Math.PI)}°`}
              <span className="block text-xs text-slate-500" title={formatDateTime(position.reported_at)}>
                Reported {timeAgo(position.reported_at)}
              </span>
            </p>
          ) : (
            <p className="text-slate-500">Unknown. Discovery also fetches it.</p>
          )}
        </div>
      </div>
      <div className="mt-4 space-y-2 text-sm text-slate-600">
        <p>
          Last discovery: <span title={formatDateTime(robot.discovered_at)}>{timeAgo(robot.discovered_at)}</span>.
          Discovery asks Keenon for the scene's floors (cleaning areas, named points on floors 1–10, and the robot's
          current floor), then each floor's map image.
        </p>
        {robot.discovery_error && <ErrorBox title="Last discovery reported">{robot.discovery_error}</ErrorBox>}
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          Discovery calls Keenon, so it only works from the IP-whitelisted network (local <code>npm run dev</code>).
          Discovered maps are saved and visible everywhere.
        </p>
      </div>
    </Card>
  )
}

function SceneControl({ detail }: { detail: KeenonRobotMapsDetail }) {
  const { robot } = detail
  const [editing, setEditing] = useState(false)
  const scenes = useStoreScenes(robot.store_external_id, editing)
  const setScene = useSetRobotScene(robot.robot_id)
  const detected = robot.detected_scene

  function choose(code: string) {
    const scene = scenes.data?.find((s) => s.code === code)
    const keyed = detail.floors.filter((f) => f.app_floor_id || f.calibrated_at).length
    if (
      keyed > 0 &&
      !confirm(
        "Changing the scene will remove this scene's floors, matches and calibrations at the next discovery. Continue?",
      )
    ) {
      return
    }
    setScene.mutate(
      { scene_code: code || null, scene_name: scene?.name ?? null },
      { onSuccess: () => setEditing(false) },
    )
  }

  return (
    <div className="text-sm">
      <p className="font-medium text-slate-700">Scene</p>
      {robot.scene.code ? (
        <p className="text-slate-600">
          {robot.scene.name ?? robot.scene.code} <span className="font-mono text-xs">({robot.scene.code})</span> ·{' '}
          {robot.scene.source === 'manual' ? 'set manually' : 'auto-detected'}
        </p>
      ) : (
        <p className="text-slate-500">Not known yet. Discover floors to detect it.</p>
      )}

      {!editing ? (
        <button type="button" className="mt-1 text-xs text-blue-600 hover:underline" onClick={() => setEditing(true)}>
          Change scene
        </button>
      ) : scenes.isPending ? (
        <Spinner className="mt-2 size-4" />
      ) : scenes.error ? (
        <div className="mt-2">
          <ErrorBox>{errorMessage(scenes.error)}</ErrorBox>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <SelectField
            label="Use scene"
            className="min-w-64"
            value={robot.scene.source === 'manual' ? (robot.scene.code ?? '') : ''}
            disabled={setScene.isPending}
            onChange={(e) => choose(e.target.value)}
            options={[
              {
                value: '',
                label: `Auto-detect${detected.code ? ` (currently ${detected.name ?? detected.code})` : ''}`,
              },
              ...(scenes.data ?? []).map((s) => ({ value: s.code, label: `${s.name} (${s.code})` })),
            ]}
          />
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Close
          </Button>
          <p className="w-full text-xs text-slate-500">After changing the scene, run Discover floors again.</p>
          {setScene.error && <ErrorBox>{errorMessage(setScene.error)}</ErrorBox>}
        </div>
      )}
    </div>
  )
}

function Floors({ detail }: { detail: KeenonRobotMapsDetail }) {
  const { data: appFloors } = useFloors()
  const { scene } = detail.robot

  return (
    <div className="space-y-4">
      {detail.other_scene_floors > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Scene changed to <strong>{scene.name ?? scene.code}</strong>. Run <strong>Discover floors</strong> to load its
          maps; the previous scene's {detail.other_scene_floors} floor{detail.other_scene_floors === 1 ? '' : 's'} (and
          any matches and calibrations) will be removed.
        </div>
      )}
      {detail.floors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No floors discovered for this scene yet. Click <strong>Discover floors</strong> above.
        </div>
      ) : (
        detail.floors.map((floor) => (
          <FloorCard key={floor.id} floor={floor} detail={detail} appFloors={appFloors ?? []} />
        ))
      )}
    </div>
  )
}

function FloorCard({
  floor,
  detail,
  appFloors,
}: {
  floor: KeenonRobotFloor
  detail: KeenonRobotMapsDetail
  appFloors: Floor[]
}) {
  const match = useMatchFloor(detail.robot.robot_id)
  const appFloor = appFloors.find((f) => f.id === floor.app_floor_id) ?? null
  const discoveredAt = detail.robot.discovered_at
  const stale = !!discoveredAt && Date.parse(floor.last_seen_at) < Date.parse(discoveredAt) - 60_000
  const rawHere =
    detail.position && floor.scene_code === detail.robot.scene.code && detail.position.floor === String(floor.floor)
      ? detail.position
      : null
  // Reported positions aren't in the map's frame; only draw the robot once the floor is aligned.
  const alignment = floorAlignment(floor)
  const robotHere = rawHere && alignment ? alignedRobot(alignment, rawHere).point : null
  // Keenon sometimes returns the same image for several floors of a scene.
  const sameImageAs = floor.map_png
    ? detail.floors
        .filter((f) => f.id !== floor.id && f.scene_code === floor.scene_code && f.map_png === floor.map_png)
        .map((f) => f.floor)
    : []

  return (
    <Card
      title={`Floor ${floor.floor}${floor.floor_label ? ` · ${floor.floor_label}` : ''}${floor.building ? ` · Building ${floor.building}` : ''}`}
      description={
        <>
          Scene <span className="font-mono">{floor.scene_code}</span> · found via{' '}
          {floor.sources.map((s) => SOURCE_LABEL[s] ?? s).join(', ')}
          {floor.map_versions.length > 1 &&
            ` · points come from ${floor.map_versions.length} map versions (the map was edited)`}
        </>
      }
      actions={
        <>
          {stale && <Badge tone="amber">Not found in last discovery</Badge>}
          <AlignmentBadge floor={floor} />
          {floor.map_png && (
            <Link
              to={`/vendors/keenon/robots/${detail.robot.robot_id}/floors/${floor.id}/align`}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {floor.aligned_at ? 'Re-align position' : 'Align position'}
            </Link>
          )}
          {floor.app_floor_id ? <Badge tone="green">Matched</Badge> : <Badge tone="slate">Not matched</Badge>}
          {floor.app_floor_id && <CalibrationBadge floor={floor} />}
          {floor.app_floor_id && floor.map_png && (
            <Link
              to={`/vendors/keenon/robots/${detail.robot.robot_id}/floors/${floor.id}/calibrate`}
              className="rounded-md bg-blue-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-blue-700"
            >
              {floor.calibrated_at ? 'Re-calibrate' : 'Calibrate'}
            </Link>
          )}
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Robot's map (Keenon)</p>
          {sameImageAs.length > 0 && (
            <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Keenon returned the <strong>same map image</strong> as floor {sameImageAs.join(', ')}. It may not have a
              separate map for this floor. Check the named points before matching.
            </p>
          )}
          <KeenonFloorMap floor={floor} robot={robotHere} />
          <p className="mt-1 text-xs text-slate-500">
            Coordinates are in Keenon's map frame (metres). Blue dots are Keenon's named points
            {robotHere ? '; the red dot is the robot' : ''}.
            {rawHere && !alignment && ' Align the robot position to show where the robot is.'}
          </p>
        </div>
        <div>
          <SelectField
            label="Matches app floor"
            value={floor.app_floor_id ?? ''}
            disabled={match.isPending}
            onChange={(e) => {
              const appFloorId = e.target.value || null
              if (
                floor.calibrated_at &&
                !confirm('This floor is calibrated against the current app floor. Changing the match removes the calibration. Continue?')
              ) {
                return
              }
              match.mutate({ floorId: floor.id, appFloorId })
            }}
            options={[
              { value: '', label: 'Not matched' },
              ...appFloors.map((f) => ({ value: f.id, label: `Level ${f.level} · ${f.name}` })),
            ]}
          />
          {match.error && (
            <div className="mt-2">
              <ErrorBox>{errorMessage(match.error)}</ErrorBox>
            </div>
          )}
          <div className="mt-3">
            <AppFloorPreview floor={appFloor} previewKey={floor.id} />
          </div>
        </div>
      </div>

      {floor.points.length > 0 && (
        <div className="mt-4">
          <PointsFlipSwitch robotId={detail.robot.robot_id} floor={floor} />
        </div>
      )}

      {floor.points.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-slate-600">
            {floor.points.length} named point{floor.points.length === 1 ? '' : 's'}
          </summary>
          <PointsTable floor={floor} />
        </details>
      )}
    </Card>
  )
}

function AlignmentBadge({ floor }: { floor: KeenonRobotFloor }) {
  if (!floor.aligned_at) return <Badge tone="slate">Position not aligned</Badge>
  return (
    <span title="The offset changes when the robot restarts or relocalizes: re-check with Track robot if positions look off.">
      <Badge tone="green">
        Position aligned{floor.align_rms_m !== null ? ` (±${formatMeters(floor.align_rms_m)})` : ''},{' '}
        {timeAgo(floor.aligned_at)}
      </Badge>
    </span>
  )
}

function CalibrationBadge({ floor }: { floor: KeenonRobotFloor }) {
  if (!floor.calibrated_at) return <Badge tone="slate">Not calibrated</Badge>
  if (floor.calibration_stale) return <Badge tone="amber">Map changed: re-check calibration</Badge>
  return (
    <Badge tone="green">
      Calibrated{floor.calib_rms_m !== null && floor.calib_pairs && floor.calib_pairs.length >= 3
        ? ` (±${formatMeters(floor.calib_rms_m)})`
        : ''}
    </Badge>
  )
}

function KeenonFloorMap({ floor, robot }: { floor: KeenonRobotFloor; robot: Point | null }) {
  const { map_png, map_width, map_height, origin_x_m, origin_y_m } = floor
  if (!map_png || !map_width || !map_height || origin_x_m === null || origin_y_m === null) {
    return (
      <div className="flex h-80 items-center justify-center rounded-md border border-dashed border-slate-300 text-sm text-slate-500">
        Keenon returned no map image for this floor.
      </div>
    )
  }
  const frame = { map_height, origin_x_m, origin_y_m, points_flipped: floor.points_flipped }
  const calibration = keenonMapCalibration(frame)
  const toLatLng = (metres: { x: number; y: number }) => pixelToLatLng(worldToPixel(metres, calibration))

  return (
    <div className="h-80 overflow-hidden rounded-md border border-slate-200">
      <PlanMap
        mapKey={`keenon-${floor.id}`}
        planUrl={`data:image/png;base64,${map_png}`}
        widthPx={map_width}
        heightPx={map_height}
        calibration={calibration}
      >
        {floor.points.map((p, i) => (
          <CircleMarker
            key={`${p.id ?? 'p'}-${i}`}
            center={toLatLng(namedPointToMeters(frame, { x: p.x_px, y: p.y_px }))}
            radius={4}
            pathOptions={{ color: '#1d4ed8', weight: 1.5, fillColor: '#60a5fa', fillOpacity: 0.9 }}
          >
            <Tooltip direction="top" offset={[0, -4]}>
              {p.name}
              {p.type ? ` (${p.type})` : ''}
            </Tooltip>
          </CircleMarker>
        ))}
        {robot && (
          <CircleMarker
            center={toLatLng(robot)}
            radius={6}
            pathOptions={{ color: '#991b1b', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }}
          >
            <Tooltip direction="top" offset={[0, -6]} permanent>
              Robot
            </Tooltip>
          </CircleMarker>
        )}
      </PlanMap>
    </div>
  )
}

function AppFloorPreview({ floor, previewKey }: { floor: Floor | null; previewKey: string }) {
  if (!floor) {
    return (
      <div className="flex h-80 items-center justify-center rounded-md border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
        Pick the app floor that shows the same place to compare the two maps.
      </div>
    )
  }
  if (!floor.plan_url || !floor.plan_width_px || !floor.plan_height_px) {
    return (
      <div className="flex h-80 items-center justify-center rounded-md border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
        “{floor.name}” has no floor plan yet. Upload one in Setup.
      </div>
    )
  }
  return (
    <div className="h-80 overflow-hidden rounded-md border border-slate-200">
      <PlanMap
        mapKey={`app-${previewKey}-${floor.id}`}
        planUrl={floor.plan_url}
        widthPx={floor.plan_width_px}
        heightPx={floor.plan_height_px}
        calibration={floor}
      />
    </div>
  )
}

function PointsTable({ floor }: { floor: KeenonRobotFloor }) {
  const frame =
    floor.map_height && floor.origin_x_m !== null && floor.origin_y_m !== null
      ? {
          map_height: floor.map_height,
          origin_x_m: floor.origin_x_m,
          origin_y_m: floor.origin_y_m,
          points_flipped: floor.points_flipped,
        }
      : null
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-slate-500">
          <tr>
            <th className="py-1 pr-3 font-medium">Name</th>
            <th className="py-1 pr-3 font-medium">Type</th>
            <th className="py-1 pr-3 font-medium">Robot x</th>
            <th className="py-1 pr-3 font-medium">Robot y</th>
            <th className="py-1 font-medium">Map version</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {floor.points.map((p, i) => {
            const m = frame ? namedPointToMeters(frame, { x: p.x_px, y: p.y_px }) : null
            return (
              <tr key={`${p.id ?? 'p'}-${i}`}>
                <td className="py-1 pr-3">{p.name}</td>
                <td className="py-1 pr-3 text-slate-500">{p.type ?? '—'}</td>
                <td className="py-1 pr-3 tabular-nums">{m ? formatMeters(m.x) : '—'}</td>
                <td className="py-1 pr-3 tabular-nums">{m ? formatMeters(m.y) : '—'}</td>
                <td className="py-1 font-mono text-slate-400">{p.map_md5?.slice(0, 8) ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-slate-400">
        Metres assume {KEENON_MAP_RESOLUTION} m per map pixel (Keenon doesn't document the resolution).
      </p>
    </div>
  )
}
