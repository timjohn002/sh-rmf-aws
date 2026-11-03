import { useState } from 'react'
import { useCheckElevator } from '../../hooks/useElevators'
import type { Elevator, ElevatorCheckResult, Floor } from '../../types/api'
import { Badge, Button, Card, errorMessage } from '../ui'

/** Floors (highest first) with the lifts that stop there. */
export function LiftsByFloorCard({
  floors,
  lifts,
  onAdd,
  onEdit,
}: {
  floors: Floor[]
  lifts: Elevator[]
  onAdd: (floorId?: string) => void
  onEdit: (lift: Elevator) => void
}) {
  const unplaced = lifts.filter((l) => l.floors.length === 0)
  return (
    <Card
      title="Lifts by floor"
      description="Each floor can have several lifts. A lift is added once and ticked for every floor it serves."
      actions={<Button onClick={() => onAdd()}>+ Add lift</Button>}
    >
      {floors.length === 0 ? (
        <p className="text-sm text-slate-500">No floors yet. Add floors on the Setup page first.</p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {floors.map((f) => {
            const here = lifts.filter((l) => l.floors.some((x) => x.floor_id === f.id))
            return (
              <div key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="w-40 shrink-0 font-medium">
                  {f.name} <span className="font-normal text-slate-400">· {f.level}</span>
                </span>
                <span className="flex flex-1 flex-wrap gap-1.5">
                  {here.length === 0 && <span className="text-slate-400">No lifts</span>}
                  {here.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => onEdit(l)}
                      className="rounded-md border border-slate-200 px-2 py-0.5 hover:border-blue-300 hover:bg-blue-50"
                      title={`${l.elevator_uuid} · LiftMind floor ${l.floors.find((x) => x.floor_id === f.id)?.liftmind_floor}`}
                    >
                      {l.name}
                      <span className="ml-1 font-mono text-xs text-slate-500">
                        {l.floors.find((x) => x.floor_id === f.id)?.liftmind_floor}
                      </span>
                    </button>
                  ))}
                </span>
                <Button variant="ghost" size="sm" onClick={() => onAdd(f.id)}>
                  + Lift
                </Button>
              </div>
            )
          })}
        </div>
      )}
      {unplaced.length > 0 && (
        <p className="mt-3 text-sm text-amber-700">
          Not on any floor yet: {unplaced.map((l) => l.name).join(', ')}. Edit them below to tick their floors.
        </p>
      )}
    </Card>
  )
}

/** All lifts with their LiftMind details, a queue check and the test ride. */
export function LiftsCard({
  lifts,
  online,
  rideRunning,
  onEdit,
  onTestRide,
}: {
  lifts: Elevator[]
  online: boolean
  rideRunning: boolean
  onEdit: (lift: Elevator) => void
  onTestRide: (lift: Elevator) => void
}) {
  return (
    <Card title="Lifts" description="Check asks LiftMind for the lift's queue; it's a quick way to confirm the IDs are right.">
      {lifts.length === 0 ? (
        <p className="text-sm text-slate-500">No lifts yet. Import setting.json or add one.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {lifts.map((l) => (
            <LiftRow key={l.id} lift={l} online={online} rideRunning={rideRunning} onEdit={onEdit} onTestRide={onTestRide} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function LiftRow({
  lift,
  online,
  rideRunning,
  onEdit,
  onTestRide,
}: {
  lift: Elevator
  online: boolean
  rideRunning: boolean
  onEdit: (lift: Elevator) => void
  onTestRide: (lift: Elevator) => void
}) {
  const check = useCheckElevator()
  const [result, setResult] = useState<ElevatorCheckResult | null>(null)
  const canRide = online && lift.enabled && lift.floors.length >= 2 && lift.robots.length > 0 && !rideRunning
  const whyNoRide = !online
    ? 'LiftMind is not connected'
    : !lift.enabled
      ? 'This lift is disabled'
      : lift.floors.length < 2
        ? 'Tick at least two floors'
        : lift.robots.length === 0
          ? 'Add a LiftMind robot'
          : rideRunning
            ? 'A test ride is already running'
            : undefined

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
      <div className="min-w-56 flex-1">
        <p className="font-medium">
          {lift.name} {!lift.enabled && <Badge tone="amber">disabled</Badge>}
        </p>
        <p className="font-mono text-xs text-slate-500">{lift.elevator_uuid}</p>
        <p className="text-xs text-slate-500">
          {lift.floors.length} floor{lift.floors.length === 1 ? '' : 's'}
          {lift.floors.length > 0 && ` (${lift.floors.map((f) => f.liftmind_floor).join(', ')})`} · {lift.robots.length} robot
          {lift.robots.length === 1 ? '' : 's'}
        </p>
        {check.error && <p className="text-xs text-red-700">{errorMessage(check.error)}</p>}
        {result && (
          <p className={result.ok ? 'text-xs text-green-700' : 'text-xs text-red-700'}>
            {result.ok
              ? `Queue: ${Object.entries(result.queue_length ?? {})
                  .map(([id, n]) => `${id} ${n ?? 'unknown'}`)
                  .join(', ') || 'empty'}`
              : `Check failed: ${result.reason ?? 'unknown reason'}`}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!online || lift.robots.length === 0 || check.isPending}
          title={!online ? 'LiftMind is not connected' : lift.robots.length === 0 ? 'Add a LiftMind robot first' : undefined}
          onClick={() => {
            setResult(null)
            check.mutate(lift.id, { onSuccess: setResult })
          }}
        >
          {check.isPending ? 'Checking…' : 'Check'}
        </Button>
        <Button variant="secondary" size="sm" disabled={!canRide} title={whyNoRide} onClick={() => onTestRide(lift)}>
          Test ride
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onEdit(lift)}>
          Edit
        </Button>
      </div>
    </li>
  )
}
