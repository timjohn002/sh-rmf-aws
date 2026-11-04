import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, Polyline, Tooltip } from 'react-leaflet'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PlanMap } from '../../components/map/PlanMap'
import { Badge, Button, Card, ErrorBox, FullPageSpinner, Toggle, cx, errorMessage, type BadgeTone } from '../../components/ui'
import { formatMeters, pixelToLatLng, pixelToWorld, worldToPixel, type PlanCalibration, type Point } from '../../lib/coords'
import { formatDateTime, timeAgo } from '../../lib/format'
import type { RobotPosition } from '../../types/api'
import {
  DEFAULT_ROTATION,
  alignHeading,
  alignPosition,
  fitBestRigid,
  fitRigid,
  offsetFromOneSample,
  sampleErrors,
  type AlignmentSample,
  type PositionAlignment,
} from './alignment'
import { floorAlignment } from './floorTransforms'
import { keenonMapCalibration, namedPointToMeters } from './mapGeometry'
import type { KeenonRobotFloor, KeenonRobotMapsDetail } from './shared'
import { useClearAlignment, useKeenonRobotMaps, useLocateRobot, useSaveAlignment } from './useKeenonMaps'

/** Keenon recommends at least ~3 s between status queries. */
const TRACK_INTERVAL_MS = 3_000
const TRAIL_LENGTH = 30
/** A reported position younger than this can be used for a sample without asking Keenon again. */
const FRESH_MS = 5_000

const SAMPLE_COLOR = '#ea580c'
const DEG = Math.PI / 180

const ROTATION_PRESETS: { label: string; rad: number }[] = [
  { label: '180° (Keenon default)', rad: DEFAULT_ROTATION },
  { label: '0°', rad: 0 },
  { label: '90°', rad: Math.PI / 2 },
  { label: '−90°', rad: -Math.PI / 2 },
]

function errorTone(m: number): BadgeTone {
  return m < 0.15 ? 'green' : m <= 0.5 ? 'amber' : 'red'
}

/** Angle in degrees, normalized to (−180, 180]. */
function degrees(rad: number): number {
  let d = (rad / DEG) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

/** `/vendors/keenon/robots/:robotId/floors/:floorId/align` */
export function KeenonAlignmentPage() {
  const { robotId = '', floorId = '' } = useParams()
  const detail = useKeenonRobotMaps(robotId)
  const back = `/vendors/keenon/robots/${robotId}`

  if (detail.isPending) return <FullPageSpinner />
  const floor = detail.data?.floors.find((f) => f.id === floorId)

  let problem: string | null = null
  if (detail.error) problem = errorMessage(detail.error)
  else if (!floor) problem = 'This Keenon floor was not found.'
  else if (!floor.map_png || !floor.map_width || !floor.map_height || floor.origin_x_m === null || floor.origin_y_m === null)
    problem = 'Keenon returned no map image for this floor, so the position cannot be aligned to it.'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6">
        <Link to={back} className="text-sm text-blue-600 hover:underline">
          ← {detail.data?.robot.name ?? 'Robot'} maps
        </Link>
        {problem || !floor || !detail.data ? (
          <ErrorBox>{problem}</ErrorBox>
        ) : (
          <AlignmentEditor key={floor.id} floor={floor} detail={detail.data} backTo={back} />
        )}
      </div>
    </div>
  )
}

function AlignmentEditor({
  floor,
  detail,
  backTo,
}: {
  floor: KeenonRobotFloor
  detail: KeenonRobotMapsDetail
  backTo: string
}) {
  const navigate = useNavigate()
  const robotId = detail.robot.robot_id
  const save = useSaveAlignment(robotId)
  const clear = useClearAlignment(robotId)
  const locate = useLocateRobot(robotId)

  const savedAlignment = floorAlignment(floor)
  const [samples, setSamples] = useState<AlignmentSample[]>(floor.align_samples ?? [])
  // Hand-tuned alignment; null = derive it from the samples. Starts as the saved one (which may be hand-tuned).
  const [manual, setManual] = useState<PositionAlignment | null>(savedAlignment)
  const [presetRotation, setPresetRotation] = useState(DEFAULT_ROTATION)
  const [mirror, setMirror] = useState(savedAlignment?.mirror ?? false)
  // Reported position frozen for the sample being taken; the next map click says where it really was.
  const [frozen, setFrozen] = useState<Point | null>(null)
  const [freezing, setFreezing] = useState(false)
  const [freezeError, setFreezeError] = useState<string | null>(null)
  const [tracking, setTracking] = useState(false)
  const [trail, setTrail] = useState<Point[]>([])
  const [saved, setSaved] = useState(false)

  const keenonFrame = {
    map_height: floor.map_height!,
    origin_x_m: floor.origin_x_m!,
    origin_y_m: floor.origin_y_m!,
    points_flipped: floor.points_flipped,
  }
  const keenonCal = useMemo(() => keenonMapCalibration(keenonFrame), [floor.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const toLatLng = (p: Point) => pixelToLatLng(worldToPixel(p, keenonCal))

  const onThisFloor = (p: RobotPosition | null): boolean =>
    !!p && floor.scene_code === detail.robot.scene.code && p.floor === String(floor.floor)
  const raw = detail.position && onThisFloor(detail.position) ? detail.position : null

  // --- the alignment being edited ----------------------------------------------------------
  const derived = useMemo(() => {
    if (samples.length === 0) return { alignment: null, error: null, best: null }
    if (samples.length === 1) return { alignment: offsetFromOneSample(presetRotation, mirror, samples[0]), error: null, best: null }
    try {
      const best = fitBestRigid(samples)
      const fit = mirror ? (best.mirrored ?? fitRigid(samples, true)) : best.plain
      return { alignment: fit.alignment, error: null, best }
    } catch (err) {
      return { alignment: null, error: errorMessage(err), best: null }
    }
  }, [samples, presetRotation, mirror])

  const alignment = manual ?? derived.alignment
  const quality = alignment && samples.length ? sampleErrors(alignment, samples) : null
  const corrected = alignment && raw ? alignPosition(alignment, raw) : null
  const correctedHeading = alignment && raw?.heading_rad != null ? alignHeading(alignment, raw.heading_rad) : null

  function updateSamples(next: AlignmentSample[]) {
    setSamples(next)
    setManual(null) // the samples take over again
    setSaved(false)
  }

  // --- tracking ----------------------------------------------------------------------------
  // Remember each newly fetched position for the trail.
  const lastFetched = useRef<string | null | undefined>(detail.position?.fetched_at)
  useEffect(() => {
    const p = detail.position
    if (!p || p.fetched_at === lastFetched.current) return
    lastFetched.current = p.fetched_at
    if (onThisFloor(p)) setTrail((t) => [...t, { x: p.x, y: p.y }].slice(-TRAIL_LENGTH))
  }, [detail.position]) // eslint-disable-line react-hooks/exhaustive-deps

  const locateRef = useRef(locate)
  locateRef.current = locate
  useEffect(() => {
    if (!tracking) return
    const tick = () => {
      if (!locateRef.current.isPending) locateRef.current.mutate()
    }
    tick()
    const timer = setInterval(tick, TRACK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [tracking])

  // "Located recently" (429) is expected while tracking or sampling; don't shout about it.
  const locateError =
    locate.error && !/located recently/i.test(errorMessage(locate.error)) ? errorMessage(locate.error) : null

  // --- samples -----------------------------------------------------------------------------
  async function takeSample() {
    setFreezeError(null)
    const fetchedAt = detail.position?.fetched_at ? Date.parse(detail.position.fetched_at) : 0
    if (raw && Date.now() - fetchedAt < FRESH_MS) {
      setFrozen({ x: raw.x, y: raw.y })
      return
    }
    setFreezing(true)
    try {
      const p = await locate.mutateAsync()
      if (onThisFloor(p)) setFrozen({ x: p.x, y: p.y })
      else setFreezeError(`The robot reports floor ${p.floor ?? '?'}, not this floor (${floor.floor}).`)
    } catch (err) {
      setFreezeError(errorMessage(err))
    } finally {
      setFreezing(false)
    }
  }

  function onMapClick(imagePx: Point) {
    if (!frozen) return
    updateSamples([...samples, { reported: frozen, map: pixelToWorld(imagePx, keenonCal) }])
    setFrozen(null)
  }

  // --- manual edits ------------------------------------------------------------------------
  function edit(patch: Partial<PositionAlignment>) {
    const base = alignment ?? { rotation: presetRotation, offset_x: 0, offset_y: 0, mirror }
    setManual({ ...base, ...patch })
    setSaved(false)
  }

  /** Rotate by `delta`, keeping the robot's corrected position (or the samples' centre) in place. */
  function rotateBy(delta: number) {
    const base = alignment ?? { rotation: presetRotation, offset_x: 0, offset_y: 0, mirror }
    const pivotRaw = raw ?? (samples.length ? centroid(samples.map((s) => s.reported)) : null)
    const next = { ...base, rotation: base.rotation + delta }
    if (pivotRaw) {
      const before = alignPosition(base, pivotRaw)
      const after = alignPosition(next, pivotRaw)
      next.offset_x += before.x - after.x
      next.offset_y += before.y - after.y
    }
    setManual(next)
    setSaved(false)
  }

  function onSave() {
    if (!alignment) return
    save.mutate(
      { floorId: floor.id, alignment: { ...alignment, samples } },
      { onSuccess: () => setSaved(true) },
    )
  }

  const step = frozen
    ? 'Click where the robot really is on the map (e.g. where its laser scan lines up in the Keenon app).'
    : samples.length === 0
      ? 'Park the robot somewhere you can recognise on the map, then press Take sample.'
      : samples.length === 1
        ? 'One sample sets the offset for the chosen rotation. For a better fit, move the robot a few metres (including sideways) and take another sample.'
        : 'Rotation and offset are fitted to the samples. A third sample, away from the line of the first two, checks for mirroring.'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Align robot position: {detail.robot.name ?? detail.robot.robot_id}, floor {floor.floor}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Keenon's location API reports positions in a different frame from its map image (usually rotated 180°
            and shifted). This lines them up. The offset can change when the robot restarts or relocalizes, so
            re-check it with <strong>Track robot</strong> if the robot looks out of place.
          </p>
        </div>
        {floor.aligned_at ? (
          <Badge tone="green">
            Saved {timeAgo(floor.aligned_at)}
            {floor.align_rms_m !== null ? ` (±${formatMeters(floor.align_rms_m)})` : ''}
          </Badge>
        ) : (
          <Badge tone="slate">Not aligned yet</Badge>
        )}
      </div>

      <div className="space-y-1 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            <strong>Step:</strong> {step}
          </span>
          {frozen && (
            <button type="button" className="text-xs underline" onClick={() => setFrozen(null)}>
              Cancel this sample
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Keenon map (map metres)</p>
          <div className="h-[65vh] min-h-80 overflow-hidden rounded-md border border-slate-200">
            <PlanMap
              mapKey={`align-keenon-${floor.id}`}
              planUrl={`data:image/png;base64,${floor.map_png}`}
              widthPx={floor.map_width!}
              heightPx={floor.map_height!}
              calibration={keenonCal}
              onPlanClick={frozen ? onMapClick : undefined}
            >
              {floor.points.map((p, i) => (
                <CircleMarker
                  key={`np-${i}`}
                  center={pixelToLatLng(worldToPixel(namedPointToMeters(keenonFrame, { x: p.x_px, y: p.y_px }), keenonCal))}
                  radius={3}
                  interactive={false}
                  pathOptions={{ color: '#1d4ed8', weight: 1, fillColor: '#60a5fa', fillOpacity: 0.8 }}
                >
                  <Tooltip direction="top" offset={[0, -3]} permanent className="!text-[10px] !px-1 !py-0">
                    {p.name}
                  </Tooltip>
                </CircleMarker>
              ))}
              {samples.map((s, i) => (
                <SampleOnMap key={`s-${i}`} sample={s} n={i + 1} alignment={alignment} toLatLng={toLatLng} />
              ))}
              {raw && (
                <CircleMarker
                  center={toLatLng(raw)}
                  radius={5}
                  interactive={false}
                  pathOptions={{ color: '#64748b', weight: 1, fillColor: '#94a3b8', fillOpacity: 0.5 }}
                >
                  <Tooltip direction="bottom" offset={[0, 5]}>
                    Reported (uncorrected)
                  </Tooltip>
                </CircleMarker>
              )}
              {alignment && trail.length > 1 && (
                <Polyline
                  positions={trail.map((p) => toLatLng(alignPosition(alignment, p)))}
                  interactive={false}
                  pathOptions={{ color: '#ef4444', weight: 2, opacity: 0.6, dashArray: '4 4' }}
                />
              )}
              {frozen && alignment && (
                <CircleMarker
                  center={toLatLng(alignPosition(alignment, frozen))}
                  radius={8}
                  interactive={false}
                  pathOptions={{ color: SAMPLE_COLOR, weight: 2, dashArray: '3 3', fillOpacity: 0 }}
                />
              )}
              {corrected && <RobotOnMap at={corrected} heading={correctedHeading} cal={keenonCal} />}
            </PlanMap>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Red: the robot with the alignment applied (dashed: recent track). Grey: what Keenon reports, uncorrected.
            Orange: samples (where you clicked), with a line to where the alignment puts them.
          </p>
        </div>

        <div className="space-y-4">
          <Card title="Robot" description="Keenon is only reachable from the whitelisted network.">
            <div className="space-y-3 text-sm">
              <Toggle
                checked={tracking}
                onChange={setTracking}
                label="Track robot"
                description="Ask Keenon where the robot is every 3 s while this page is open. Push the robot and check the red dot moves the same way."
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" disabled={locate.isPending || tracking} onClick={() => locate.mutate()}>
                  {locate.isPending && !tracking ? 'Locating…' : 'Locate once'}
                </Button>
                <Button disabled={freezing || !!frozen} onClick={takeSample}>
                  {freezing ? 'Locating…' : 'Take sample'}
                </Button>
                {trail.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setTrail([])}>
                    Clear track
                  </Button>
                )}
              </div>
              {raw ? (
                <p className="text-slate-600">
                  Reported {formatMeters(raw.x)}, {formatMeters(raw.y)}
                  {corrected && (
                    <>
                      {' '}→ map {formatMeters(corrected.x)}, {formatMeters(corrected.y)}
                    </>
                  )}
                  . Robot time {formatDateTime(raw.reported_at)}
                  {raw.fetched_at && `, asked ${timeAgo(raw.fetched_at)}`}.
                </p>
              ) : (
                <p className="text-slate-500">
                  {detail.position
                    ? `The robot's last position is on floor ${detail.position.floor ?? '?'}, not this floor.`
                    : 'No position yet. Press Locate once.'}
                </p>
              )}
              {frozen && (
                <p className="text-orange-700">
                  Sample frozen at reported {formatMeters(frozen.x)}, {formatMeters(frozen.y)}. Now click its true spot
                  on the map.
                </p>
              )}
              {(freezeError || locateError) && <ErrorBox>{freezeError ?? locateError}</ErrorBox>}
            </div>
          </Card>

          <Card
            title="Samples"
            description="Each sample pairs a reported position with where the robot really was."
            actions={
              samples.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => updateSamples([])}>
                  Clear all
                </Button>
              )
            }
          >
            {samples.length === 0 ? (
              <p className="text-sm text-slate-500">No samples yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-1 font-medium">#</th>
                    <th className="py-1 font-medium">Reported</th>
                    <th className="py-1 font-medium">True spot</th>
                    <th className="py-1 font-medium">Error</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {samples.map((s, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="py-1">{i + 1}</td>
                      <td className="py-1">
                        {formatMeters(s.reported.x)}, {formatMeters(s.reported.y)}
                      </td>
                      <td className="py-1">
                        {formatMeters(s.map.x)}, {formatMeters(s.map.y)}
                      </td>
                      <td className="py-1">
                        {quality ? <Badge tone={errorTone(quality.errors_m[i])}>{formatMeters(quality.errors_m[i])}</Badge> : '–'}
                      </td>
                      <td className="py-1 text-right">
                        <button
                          type="button"
                          className="text-xs text-red-600 hover:underline"
                          onClick={() => updateSamples(samples.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {quality && samples.length >= 2 && (
              <p className="mt-2 text-sm text-slate-600">
                Overall error <Badge tone={errorTone(quality.rms_m)}>±{formatMeters(quality.rms_m)}</Badge>
              </p>
            )}
            {derived.error && (
              <div className="mt-2">
                <ErrorBox>{derived.error}</ErrorBox>
              </div>
            )}
            {derived.best?.suggestMirror && !mirror && derived.best.mirrored && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                A mirrored alignment fits much better (±{formatMeters(derived.best.mirrored.rms_m)} vs ±
                {formatMeters(derived.best.plain.rms_m)}).{' '}
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() => {
                    setMirror(true)
                    setManual(null)
                  }}
                >
                  Use mirror
                </button>
              </div>
            )}
          </Card>

          <Card title="Alignment" description="Derived from the samples; adjust by hand if needed.">
            <div className="space-y-3 text-sm">
              {samples.length <= 1 && (
                <label className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-700">Rotation preset</span>
                  <select
                    value={presetRotation}
                    onChange={(e) => {
                      setPresetRotation(Number(e.target.value))
                      setManual(null)
                      setSaved(false)
                    }}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
                  >
                    {ROTATION_PRESETS.map((p) => (
                      <option key={p.label} value={p.rad}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={mirror}
                  onChange={(e) => {
                    setMirror(e.target.checked)
                    setManual(null)
                    setSaved(false)
                  }}
                />
                <span className="text-slate-700">Mirror (flip the reported y axis)</span>
              </label>

              <div className="grid grid-cols-3 gap-2">
                <NumberField
                  label="Rotation (°)"
                  value={alignment ? degrees(alignment.rotation) : null}
                  digits={2}
                  onCommit={(d) => edit({ rotation: d * DEG })}
                />
                <NumberField
                  label="Offset X (m)"
                  value={alignment?.offset_x ?? null}
                  digits={3}
                  onCommit={(v) => edit({ offset_x: v })}
                />
                <NumberField
                  label="Offset Y (m)"
                  value={alignment?.offset_y ?? null}
                  digits={3}
                  onCommit={(v) => edit({ offset_y: v })}
                />
              </div>

              <div className="flex flex-wrap gap-1.5">
                <NudgeButton label="↺ 1°" onClick={() => rotateBy(DEG)} />
                <NudgeButton label="↻ 1°" onClick={() => rotateBy(-DEG)} />
                <NudgeButton label="← 5 cm" onClick={() => edit({ offset_x: (alignment?.offset_x ?? 0) - 0.05 })} />
                <NudgeButton label="→ 5 cm" onClick={() => edit({ offset_x: (alignment?.offset_x ?? 0) + 0.05 })} />
                <NudgeButton label="↑ 5 cm" onClick={() => edit({ offset_y: (alignment?.offset_y ?? 0) + 0.05 })} />
                <NudgeButton label="↓ 5 cm" onClick={() => edit({ offset_y: (alignment?.offset_y ?? 0) - 0.05 })} />
                {manual && derived.alignment && (
                  <NudgeButton
                    label="Use computed"
                    onClick={() => {
                      setManual(null)
                      setSaved(false)
                    }}
                  />
                )}
              </div>
              <p className="text-xs text-slate-500">
                Rotation nudges turn around the robot's current position, so the red dot stays put while its track
                turns. {manual ? 'Hand-tuned: changing the samples replaces it with a new fit.' : ''}
              </p>
            </div>
          </Card>
        </div>
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-slate-200 bg-slate-50/95 py-3 backdrop-blur">
        <Button disabled={!alignment || save.isPending} onClick={onSave}>
          {save.isPending ? 'Saving…' : 'Save alignment'}
        </Button>
        <Button variant="secondary" onClick={() => navigate(backTo)}>
          Back
        </Button>
        {saved && !save.isPending && <span className="text-sm text-green-700">Saved</span>}
        {save.error && <span className="text-sm text-red-700">{errorMessage(save.error)}</span>}
        {floor.aligned_at && (
          <Button
            variant="ghost"
            className="ml-auto text-red-600 hover:bg-red-50"
            disabled={clear.isPending}
            onClick={() => {
              if (confirm('Remove the saved position alignment for this floor? The robot will be hidden on its maps.')) {
                clear.mutate(floor.id, {
                  onSuccess: () => {
                    setSamples([])
                    setManual(null)
                    setSaved(false)
                  },
                })
              }
            }}
          >
            Remove alignment
          </Button>
        )}
      </div>
    </div>
  )
}

function centroid(points: Point[]): Point {
  return {
    x: points.reduce((t, p) => t + p.x, 0) / points.length,
    y: points.reduce((t, p) => t + p.y, 0) / points.length,
  }
}

/** A number input that keeps what is typed and applies it on Enter or when leaving the field. */
function NumberField({
  label,
  value,
  digits,
  onCommit,
}: {
  label: string
  value: number | null
  digits: number
  onCommit: (value: number) => void
}) {
  const shown = value === null ? '' : value.toFixed(digits)
  const [text, setText] = useState<string | null>(null)
  function commit() {
    if (text === null) return
    const v = Number(text)
    if (text.trim() !== '' && Number.isFinite(v)) onCommit(v)
    setText(null)
  }
  return (
    <label className="block">
      <span className="block text-xs text-slate-500">{label}</span>
      <input
        inputMode="decimal"
        value={text ?? shown}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(null)
        }}
        className={cx(
          'w-full rounded border px-2 py-1 text-sm tabular-nums',
          text !== null ? 'border-blue-400' : 'border-slate-300',
        )}
      />
    </label>
  )
}

function NudgeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="secondary" onClick={onClick} className="tabular-nums">
      {label}
    </Button>
  )
}

/** The clicked true spot, plus (with an alignment) where the reported position lands and the gap between them. */
function SampleOnMap({
  sample,
  n,
  alignment,
  toLatLng,
}: {
  sample: AlignmentSample
  n: number
  alignment: PositionAlignment | null
  toLatLng: (p: Point) => [number, number]
}) {
  const predicted = alignment ? alignPosition(alignment, sample.reported) : null
  return (
    <>
      {predicted && (
        <>
          <Polyline
            positions={[toLatLng(sample.map), toLatLng(predicted)]}
            interactive={false}
            pathOptions={{ color: '#dc2626', weight: 2 }}
          />
          <CircleMarker
            center={toLatLng(predicted)}
            radius={3}
            interactive={false}
            pathOptions={{ color: '#dc2626', weight: 1, fillColor: '#fff', fillOpacity: 1 }}
          />
        </>
      )}
      <CircleMarker
        center={toLatLng(sample.map)}
        radius={7}
        interactive={false}
        pathOptions={{ color: '#7c2d12', weight: 2, fillColor: SAMPLE_COLOR, fillOpacity: 1 }}
      >
        <Tooltip direction="right" offset={[6, 0]} permanent>
          {n}
        </Tooltip>
      </CircleMarker>
    </>
  )
}

function RobotOnMap({ at, heading, cal }: { at: Point; heading: number | null; cal: PlanCalibration }) {
  const toLatLng = (p: Point) => pixelToLatLng(worldToPixel(p, cal))
  // 0.6 m arrow in map metres (y up).
  const tip = heading !== null ? { x: at.x + 0.6 * Math.cos(heading), y: at.y + 0.6 * Math.sin(heading) } : null
  return (
    <>
      {tip && (
        <Polyline positions={[toLatLng(at), toLatLng(tip)]} interactive={false} pathOptions={{ color: '#991b1b', weight: 3 }} />
      )}
      <CircleMarker
        center={toLatLng(at)}
        radius={6}
        interactive={false}
        pathOptions={{ color: '#991b1b', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }}
      >
        <Tooltip direction="top" offset={[0, -6]} permanent>
          Robot
        </Tooltip>
      </CircleMarker>
    </>
  )
}
