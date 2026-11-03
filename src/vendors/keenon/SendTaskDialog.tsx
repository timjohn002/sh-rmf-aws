import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button, ErrorBox, Modal, SelectField, Spinner, errorMessage } from '../../components/ui'
import type { Robot } from '../../types/api'
import { FINISHED_TASK_STATES, canTakeTasks, type KeenonTaskSent } from './shared'
import { useCancelTask, useRefreshTaskPoints, useSendTask, useTaskFloors, useTaskPoints } from './useKeenonMaps'

/** Send task / Cancel task buttons for a Keenon robot's row on the Robots page (S100 only, admins). */
export function KeenonRobotActions({ robot }: { robot: Robot }) {
  const [open, setOpen] = useState(false)
  const cancel = useCancelTask(robot.id)
  if (!canTakeTasks(robot.model)) return null

  const task = robot.current_task
  const running = !!task?.task_no && task.type === 'Remote call' && !FINISHED_TASK_STATES.has(task.state)
  // Whether Keenon accepts a call is checked live when the dialog opens (the stored flag can be stale).
  const why = robot.online === false ? 'The robot is offline' : undefined

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" disabled={!!why} title={why} onClick={() => setOpen(true)}>
        Send task
      </Button>
      {running && (
        <Button
          size="sm"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => {
            if (confirm(`Cancel task ${task.task_no}?`)) cancel.mutate()
          }}
        >
          {cancel.isPending ? 'Cancelling…' : 'Cancel task'}
        </Button>
      )}
      {cancel.error && <span className="text-xs text-red-700">{errorMessage(cancel.error)}</span>}
      {open && <SendTaskDialog robot={robot} onClose={() => setOpen(false)} />}
    </div>
  )
}

/** Pick a floor and one of its "normal" points, then send the robot there (Keenon remote call). */
export function SendTaskDialog({ robot, onClose }: { robot: Robot; onClose: () => void }) {
  const floors = useTaskFloors(robot.id)
  const [floor, setFloor] = useState<number | null>(null)
  const points = useTaskPoints(robot.id, floor)
  const refresh = useRefreshTaskPoints(robot.id)
  const send = useSendTask(robot.id)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sent, setSent] = useState<KeenonTaskSent | null>(null)
  const queryClient = useQueryClient()
  const callable = floors.data?.can_be_called ?? null

  // Opening the dialog asks Keenon whether the robot is callable and saves it: refresh the Robots page.
  useEffect(() => {
    if (floors.data) queryClient.invalidateQueries({ queryKey: ['robots'] })
  }, [floors.data, queryClient])

  // Start on the floor the robot is on (or the first one).
  useEffect(() => {
    if (floor === null && floors.data?.floors.length) {
      setFloor((floors.data.floors.find((f) => f.current) ?? floors.data.floors[0]).floor)
    }
  }, [floors.data, floor])

  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    const all = points.data?.points ?? []
    return q ? all.filter((p) => `${p.name} ${p.area ?? ''}`.toLowerCase().includes(q)) : all
  }, [points.data, search])
  const point = points.data?.points.find((p) => p.uuid === selected) ?? null
  const robotFloor = floors.data?.floors.find((f) => f.current) ?? null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!point) return
    send.mutate({ uuid: point.uuid, point_id: point.point_id, point_name: point.name }, { onSuccess: setSent })
  }

  const name = robot.name ?? robot.external_id
  if (sent) {
    return (
      <Modal open title={`Task sent to ${name}`} onClose={onClose}>
        <div className="space-y-3 text-sm">
          <p>
            Keenon accepted the task to <strong>{point?.name}</strong>.
          </p>
          <p className="text-slate-600">
            Task <span className="font-mono">{sent.task_no}</span>
            {sent.queue_position !== null && ` · queue position ${sent.queue_position}`}
          </p>
          <p className="text-slate-500">Its progress shows under Current task on the Robots page as Keenon reports it.</p>
          <Button onClick={onClose}>Close</Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open title={`Send ${name} to a point`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {floors.isPending ? (
          <Spinner />
        ) : floors.error ? (
          <ErrorBox>{errorMessage(floors.error)}</ErrorBox>
        ) : floors.data.floors.length === 0 ? (
          <ErrorBox title="No floors yet">
            Discover the robot's floors on its{' '}
            <Link className="underline" to={`/vendors/keenon/robots/${robot.id}`}>
              map page
            </Link>{' '}
            first.
          </ErrorBox>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <SelectField
                className="flex-1"
                label="Floor"
                options={floors.data.floors.map((f) => ({
                  value: String(f.floor),
                  label: `Floor ${f.floor}${f.label ? ` · ${f.label}` : ''}${f.current ? ' (robot is here)' : ''}`,
                }))}
                value={floor === null ? '' : String(floor)}
                onChange={(e) => {
                  setFloor(Number(e.target.value))
                  setSelected(null)
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                className="mb-1"
                disabled={floor === null || refresh.isPending || points.isFetching}
                onClick={() => floor !== null && refresh.mutate(floor)}
              >
                {refresh.isPending ? 'Reloading…' : 'Reload points'}
              </Button>
            </div>

            {robotFloor && floor !== null && floor !== robotFloor.floor && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                The robot is on floor {robotFloor.floor}. Tasks on another floor need Keenon's lift setup and won't complete
                yet.
              </p>
            )}

            <div>
              <p className="mb-1 text-sm font-medium text-slate-700">Point</p>
              {points.isPending && floor !== null ? (
                <Spinner />
              ) : points.error || refresh.error ? (
                <ErrorBox>{errorMessage(points.error ?? refresh.error)}</ErrorBox>
              ) : (
                <>
                  {(points.data?.points.length ?? 0) > 8 && (
                    <input
                      placeholder="Search points"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="mb-2 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  )}
                  {points.data?.points.length === 0 ? (
                    <p className="text-sm text-slate-500">No points of type "normal" on this floor.</p>
                  ) : (
                    <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
                      {list.map((p) => (
                        <label key={p.uuid} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50">
                          <input
                            type="radio"
                            name="point"
                            checked={selected === p.uuid}
                            onChange={() => setSelected(p.uuid)}
                          />
                          <span className="flex-1">{p.name}</span>
                          {p.area && <span className="text-xs text-slate-500">{p.area}</span>}
                        </label>
                      ))}
                    </div>
                  )}
                  {!!points.data?.unmatched && (
                    <p className="mt-1 text-xs text-amber-700">
                      {points.data.unmatched} normal point{points.data.unmatched === 1 ? '' : 's'} on this floor aren't in
                      the scene's target list, so they can't be sent to. Try Reload points.
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {floors.data && (
          <div
            className={
              callable === false
                ? 'flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900'
                : 'flex flex-wrap items-center gap-2 text-sm text-slate-600'
            }
          >
            <span className="flex-1">
              {callable === true
                ? 'Keenon: the robot can take a call now.'
                : callable === false
                  ? 'Keenon says the robot can’t be called right now (busy, not idle, or remote call turned off in its app).'
                  : `Couldn't check with Keenon whether the robot is callable${floors.data.status_error ? `: ${floors.data.status_error}` : '.'}`}
            </span>
            <Button variant="ghost" size="sm" disabled={floors.isFetching} onClick={() => floors.refetch()}>
              {floors.isFetching ? 'Checking…' : 'Check again'}
            </Button>
          </div>
        )}
        <p className="text-xs text-slate-500">
          Keenon only takes the task if the robot is deployed, remote call is turned on in the robot's app, and the robot is
          idle. Calls only work from an IP address Keenon has whitelisted.
        </p>
        {send.error && <ErrorBox title="Keenon refused the task">{errorMessage(send.error)}</ErrorBox>}
        <div className="flex gap-2">
          <Button type="submit" disabled={!point || send.isPending || callable === false}>
            {send.isPending ? 'Sending…' : point ? `Send to ${point.name}` : 'Send'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  )
}
