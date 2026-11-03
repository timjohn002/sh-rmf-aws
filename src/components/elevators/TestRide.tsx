import { useState, type FormEvent } from 'react'
import { useStartTestRide, useTestRideAction } from '../../hooks/useElevators'
import { RIDE_SIDE_STATE, RIDE_STEPS, rideFinished } from '../../lib/elevators'
import { formatDateTime } from '../../lib/format'
import type { Elevator, Floor, TestRide } from '../../types/api'
import { Badge, Button, Card, ErrorBox, Modal, SelectField, Toggle, cx, errorMessage } from '../ui'

/** Pick robot and floors, then send ELEVATOR_REQUEST. */
export function StartTestRideDialog({ lift, floors, onClose }: { lift: Elevator; floors: Floor[]; onClose: () => void }) {
  const start = useStartTestRide()
  // The lift's floors in building order, highest first.
  const served = floors.filter((f) => lift.floors.some((x) => x.floor_id === f.id))
  const name = (floorId: string) => {
    const f = served.find((x) => x.id === floorId)
    return `${f?.name} (${lift.floors.find((x) => x.floor_id === floorId)?.liftmind_floor})`
  }
  const [robot, setRobot] = useState(lift.robots[0]?.liftmind_robot_id ?? '')
  const [from, setFrom] = useState(served.at(-1)?.id ?? '')
  const [to, setTo] = useState(served[0]?.id ?? '')
  const [separated, setSeparated] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  function submit(e: FormEvent) {
    e.preventDefault()
    start.mutate(
      { id: lift.id, input: { robot, from_floor_id: from, to_floor_id: to, separated } },
      { onSuccess: onClose },
    )
  }

  const floorOptions = served.map((f) => ({ value: f.id, label: name(f.id) }))
  return (
    <Modal open title={`Test ride: ${lift.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>This calls a real lift</strong> unless the connection points at Owlsome Tech's Beta / virtual elevator or the
          local fake. You play the robot: you'll press <em>Robot entered</em> and <em>Robot exited</em> yourself.
        </div>
        <SelectField
          label="As robot"
          options={lift.robots.map((r) => ({ value: r.liftmind_robot_id, label: r.liftmind_robot_id }))}
          value={robot}
          onChange={(e) => setRobot(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="From" options={floorOptions} value={from} onChange={(e) => setFrom(e.target.value)} />
          <SelectField label="To" options={floorOptions} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Toggle
          checked={separated}
          onChange={setSeparated}
          label="Separated mode"
          description="Robot rides alone: LiftMind waits for an empty car (can take longer)."
        />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I understand this may move a real lift.
        </label>
        {from === to && <p className="text-sm text-amber-700">Choose two different floors.</p>}
        {start.error && <ErrorBox>{errorMessage(start.error)}</ErrorBox>}
        <div className="flex gap-2">
          <Button type="submit" disabled={!confirmed || !robot || from === to || start.isPending}>
            {start.isPending ? 'Sending…' : 'Call the lift'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** The running (or last) test ride: progress, the robot's buttons and what happened. */
export function TestRideCard({ ride, lift }: { ride: TestRide; lift: Elevator | undefined }) {
  const action = useTestRideAction()
  const [recoverTo, setRecoverTo] = useState(ride.from_floor)
  const finished = rideFinished(ride)
  const side = RIDE_SIDE_STATE[ride.stage]
  // The furthest normal step reached (side states like recovery don't count as steps).
  const lastStep = Math.max(...ride.history.map((h) => RIDE_STEPS.findIndex((s) => s.stage === h.stage)))
  const busy = action.isPending

  return (
    <Card
      title={`Test ride: ${ride.elevator_name}`}
      description={`Robot ${ride.robot} · ${ride.from_floor} → ${ride.to_floor}${ride.assigned_elevator ? ` · lift ${ride.assigned_elevator}` : ''}`}
      actions={side && <Badge tone={side.tone}>{side.label}</Badge>}
    >
      <ol className="mb-4 flex flex-wrap gap-1">
        {RIDE_STEPS.map((s, i) => (
          <li
            key={s.stage}
            className={cx(
              'rounded px-2 py-1 text-xs font-medium',
              i < lastStep || (i === lastStep && finished && ride.stage === 'done')
                ? 'bg-green-100 text-green-800'
                : i === lastStep
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 text-slate-500',
            )}
          >
            {s.label}
          </li>
        ))}
      </ol>

      {ride.reason && !['done'].includes(ride.stage) && (
        <p className="mb-3 text-sm text-red-700">Reason: {ride.reason}</p>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-2">
        {ride.stage === 'at_start' && (
          <>
            <Button disabled={busy} onClick={() => action.mutate({ action: 'entered', ok: true })}>
              Robot entered
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => action.mutate({ action: 'entered', ok: false })}>
              Robot could not enter
            </Button>
          </>
        )}
        {ride.stage === 'at_destination' && (
          <>
            <Button disabled={busy} onClick={() => action.mutate({ action: 'exited', ok: true })}>
              Robot exited
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => action.mutate({ action: 'exited', ok: false })}>
              Robot could not exit
            </Button>
          </>
        )}
        {ride.stage === 'pending_recovery' && (
          <>
            <SelectField
              className="w-40"
              label="Recover to floor"
              options={(lift?.floors ?? []).map((f) => ({ value: f.liftmind_floor, label: f.liftmind_floor }))}
              value={recoverTo}
              onChange={(e) => setRecoverTo(e.target.value)}
            />
            <Button disabled={busy || !recoverTo} onClick={() => action.mutate({ action: 'recover', to_floor: recoverTo })}>
              Recover
            </Button>
          </>
        )}
        {['requested', 'dispatched', 'entered', 'recovering'].includes(ride.stage) && (
          <span className="text-sm text-slate-500">Waiting for LiftMind…</span>
        )}
        {!finished && (
          <Button variant="danger" disabled={busy} onClick={() => action.mutate({ action: 'cancel' })}>
            Cancel ride
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (finished || confirm('Forget this ride here without telling LiftMind? Use Cancel ride to stop the lift mission.')) {
              action.mutate({ action: 'clear' })
            }
          }}
        >
          {finished ? 'Close' : 'Forget'}
        </Button>
      </div>
      {action.error && <ErrorBox>{errorMessage(action.error)}</ErrorBox>}

      <ul className="space-y-1 text-sm">
        {[...ride.history].reverse().map((h, i) => (
          <li key={i} className="flex gap-3">
            <span className="w-36 shrink-0 text-slate-500">{formatDateTime(h.at)}</span>
            <span>{h.note}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
