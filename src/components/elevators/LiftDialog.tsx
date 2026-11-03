import { useState, type FormEvent } from 'react'
import { useDeleteElevator, useSaveElevator } from '../../hooks/useElevators'
import { suggestLiftMindFloor } from '../../lib/elevators'
import type { Elevator, ElevatorRobot, Floor, Robot } from '../../types/api'
import { Button, ErrorBox, Modal, SelectField, TextField, Toggle, errorMessage } from '../ui'

interface FloorChoice {
  served: boolean
  liftmind_floor: string
}

/** Add or edit a lift: the floors it serves (with LiftMind's floor names) and the robots allowed to use it. */
export function LiftDialog({
  lift,
  floors,
  robots,
  presetFloorId,
  onClose,
}: {
  /** null: a new lift. */
  lift: Elevator | null
  /** Highest first. */
  floors: Floor[]
  robots: Robot[]
  /** For a new lift: tick this floor already. */
  presetFloorId?: string
  onClose: () => void
}) {
  const save = useSaveElevator()
  const remove = useDeleteElevator()
  const [name, setName] = useState(lift?.name ?? '')
  const [elevatorUuid, setElevatorUuid] = useState(lift?.elevator_uuid ?? '')
  const [lobbyUuid, setLobbyUuid] = useState(lift?.lobby_uuid ?? '')
  const [enabled, setEnabled] = useState(lift?.enabled ?? true)
  const [choices, setChoices] = useState<Record<string, FloorChoice>>(() =>
    Object.fromEntries(
      floors.map((f) => {
        const saved = lift?.floors.find((x) => x.floor_id === f.id)
        return [
          f.id,
          { served: !!saved || (!lift && f.id === presetFloorId), liftmind_floor: saved?.liftmind_floor ?? suggestLiftMindFloor(f.level) },
        ]
      }),
    ),
  )
  const [liftRobots, setLiftRobots] = useState<ElevatorRobot[]>(lift?.robots ?? [])

  const setChoice = (id: string, change: Partial<FloorChoice>) =>
    setChoices((c) => ({ ...c, [id]: { ...c[id], ...change } }))
  const setRobot = (i: number, change: Partial<ElevatorRobot>) =>
    setLiftRobots((rs) => rs.map((r, j) => (j === i ? { ...r, ...change } : r)))

  const robotOptions = [
    { value: '', label: 'Not linked' },
    ...robots.map((r) => ({ value: r.id, label: `${r.name ?? r.external_id} (${r.vendor})` })),
  ]

  function submit(e: FormEvent) {
    e.preventDefault()
    save.mutate(
      {
        id: lift?.id ?? null,
        input: {
          name,
          elevator_uuid: elevatorUuid,
          lobby_uuid: lobbyUuid || null,
          enabled,
          floors: floors
            .filter((f) => choices[f.id]?.served)
            .map((f) => ({ floor_id: f.id, liftmind_floor: choices[f.id].liftmind_floor.trim() })),
          robots: liftRobots
            .map((r) => ({ ...r, liftmind_robot_id: r.liftmind_robot_id.trim() }))
            .filter((r) => r.liftmind_robot_id),
        },
      },
      { onSuccess: onClose },
    )
  }

  return (
    <Modal open title={lift ? `Edit ${lift.name}` : 'Add lift'} onClose={onClose} size="lg">
      <form onSubmit={submit} className="max-h-[75vh] space-y-5 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Name" placeholder="Lift A" required value={name} onChange={(e) => setName(e.target.value)} />
          <TextField
            label="Elevator UUID"
            hint="From LiftMind (setting.json: controllable_elevators)."
            placeholder="lc-…"
            required
            value={elevatorUuid}
            onChange={(e) => setElevatorUuid(e.target.value)}
          />
          <TextField
            label="Lobby UUID (optional)"
            hint="Only needed if LiftMind should pick a lift in a lobby instead."
            value={lobbyUuid}
            onChange={(e) => setLobbyUuid(e.target.value)}
          />
          <div className="pt-6">
            <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
          </div>
        </div>

        <section>
          <h3 className="text-sm font-semibold text-slate-700">Floors this lift serves</h3>
          <p className="mb-2 text-xs text-slate-500">
            Tick each floor and enter LiftMind's name for it, exactly as Owlsome Tech configured the site (e.g. 1F, B1F, G).
          </p>
          {floors.length === 0 ? (
            <p className="text-sm text-slate-500">No floors yet. Add floors on the Setup page first.</p>
          ) : (
            <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {floors.map((f) => {
                const choice = choices[f.id]
                return (
                  <label key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={choice.served}
                      onChange={(e) => setChoice(f.id, { served: e.target.checked })}
                      className="size-4"
                    />
                    <span className="flex-1">
                      {f.name} <span className="text-slate-400">· level {f.level}</span>
                    </span>
                    <span className="text-xs text-slate-500">LiftMind floor</span>
                    <input
                      aria-label={`LiftMind floor name for ${f.name}`}
                      disabled={!choice.served}
                      value={choice.liftmind_floor}
                      onChange={(e) => setChoice(f.id, { liftmind_floor: e.target.value })}
                      className="w-20 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs disabled:bg-slate-100 disabled:text-slate-400"
                    />
                  </label>
                )
              })}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-sm font-semibold text-slate-700">Robots allowed to use it</h3>
          <p className="mb-2 text-xs text-slate-500">
            LiftMind robot IDs (setting.json: robots → uuid). Linking an app robot is optional; it's for driving lifts from
            robot callbacks later.
          </p>
          <div className="space-y-2">
            {liftRobots.map((r, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <TextField
                  className="min-w-56 flex-1"
                  label="LiftMind robot ID"
                  placeholder="rb-…"
                  value={r.liftmind_robot_id}
                  onChange={(e) => setRobot(i, { liftmind_robot_id: e.target.value })}
                />
                <SelectField
                  className="min-w-48 flex-1"
                  label="App robot"
                  options={robotOptions}
                  value={r.robot_id ?? ''}
                  onChange={(e) => setRobot(i, { robot_id: e.target.value || null })}
                />
                <Button variant="ghost" size="sm" className="mb-1" onClick={() => setLiftRobots((rs) => rs.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => setLiftRobots((rs) => [...rs, { liftmind_robot_id: '', robot_id: null }])}>
              + Add robot
            </Button>
          </div>
        </section>

        {(save.error || remove.error) && <ErrorBox>{errorMessage(save.error ?? remove.error)}</ErrorBox>}

        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {lift && (
            <Button
              variant="danger"
              className="ml-auto"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm(`Delete ${lift.name}? Its floor and robot settings are removed too.`)) {
                  remove.mutate(lift.id, { onSuccess: onClose })
                }
              }}
            >
              Delete lift
            </Button>
          )}
        </div>
      </form>
    </Modal>
  )
}
