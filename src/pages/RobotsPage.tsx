import { useEffect, useState, type ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Badge, Button, ErrorBox, FullPageSpinner, cx, errorMessage, type BadgeTone } from '../components/ui'
import { VendorStatusBadge } from '../components/vendors/common'
import { useRefreshVendorRobots, useRobots } from '../hooks/useRobots'
import { ApiError } from '../lib/api'
import { formatDateTime, timeAgo } from '../lib/format'
import { refreshWaitSeconds } from '../lib/robotRefresh'
import type { Robot, RobotGroup, RobotTask, WorkState } from '../types/api'
import { VENDOR_UI } from '../vendors'

const WORK_STATE: Record<WorkState, { tone: BadgeTone; label: string }> = {
  idle: { tone: 'green', label: 'Idle' },
  busy: { tone: 'blue', label: 'On task' },
  charging: { tone: 'amber', label: 'Charging' },
  operating: { tone: 'purple', label: 'Operating' },
  scheduling: { tone: 'purple', label: 'Scheduling' },
  starting: { tone: 'slate', label: 'Starting up' },
  offline: { tone: 'slate', label: 'Offline' },
  unknown: { tone: 'slate', label: 'Unknown' },
}

const TASK_TONE: Record<string, BadgeTone> = {
  completed: 'green',
  failed: 'red',
  cancelled: 'slate',
  in_progress: 'blue',
  calling: 'blue',
  queued: 'amber',
  waiting: 'amber',
  arrived: 'green',
}

const COLLAPSED_KEY = 'robots.collapsedVendors'

/** Current time, re-rendering every second (drives the Refresh countdowns). */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** Which vendor sections are collapsed; remembered per browser (best effort). */
function useCollapsedVendors(): [Set<string>, (vendorId: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  function toggle(vendorId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(vendorId)) next.add(vendorId)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // Storage unavailable (private mode etc.): keep it for this visit only.
      }
      return next
    })
  }
  return [collapsed, toggle]
}

export function RobotsPage() {
  const { user } = useAuth()
  const { data, isPending, error, dataUpdatedAt } = useRobots()
  const [collapsed, toggleCollapsed] = useCollapsedVendors()
  const now = useNow()

  if (isPending) return <FullPageSpinner />
  const groups = data?.groups ?? []

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
        <div>
          <h1 className="text-xl font-semibold">Robots</h1>
          <p className="text-sm text-slate-500">
            Live status from vendor callbacks, grouped by vendor. Updated{' '}
            {timeAgo(new Date(dataUpdatedAt).toISOString())}, refreshes every 10 s.
          </p>
        </div>

        {error && <ErrorBox>{errorMessage(error)}</ErrorBox>}

        {groups.length === 0 && !error ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <h2 className="font-semibold">No robots yet</h2>
            <p className="mt-1 text-sm text-slate-500">
              Robots appear here after a vendor is configured and synced, or when a vendor sends a callback.
            </p>
            {user?.role === 'admin' && (
              <Link to="/vendors" className="mt-3 inline-block text-sm text-blue-600 hover:underline">
                Configure robot vendors
              </Link>
            )}
          </div>
        ) : (
          groups.map((group) => (
            <VendorSection
              key={group.vendor.id}
              group={group}
              now={now}
              isAdmin={user?.role === 'admin'}
              collapsed={collapsed.has(group.vendor.id)}
              onToggle={() => toggleCollapsed(group.vendor.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

/** One vendor's robots. Vendor-specific behaviour comes from the group's capabilities and VENDOR_UI. */
function VendorSection({
  group,
  now,
  isAdmin,
  collapsed,
  onToggle,
}: {
  group: RobotGroup
  now: number
  isAdmin: boolean
  collapsed: boolean
  onToggle: () => void
}) {
  const { vendor, robots } = group
  const refresh = useRefreshVendorRobots()
  const [refreshError, setRefreshError] = useState<string | null>(null)
  // Server-reported cooldown (e.g. another session just refreshed this vendor), as epoch ms.
  const [blockedUntil, setBlockedUntil] = useState(0)
  const online = robots.filter((r) => r.online === true).length
  const RobotDetail = VENDOR_UI[vendor.id]?.RobotDetail
  const RobotActions = isAdmin ? VENDOR_UI[vendor.id]?.RobotActions : undefined
  const cooldownSeconds = vendor.capabilities.refresh_cooldown_ms / 1000
  const waitSeconds = Math.max(
    refreshWaitSeconds(vendor.last_refreshed_at, vendor.capabilities.refresh_cooldown_ms, now),
    Math.ceil((blockedUntil - now) / 1000),
    0,
  )

  function onRefresh() {
    setRefreshError(null)
    refresh.mutate(vendor.id, {
      onError: (e) => {
        if (e instanceof ApiError && e.status === 429) {
          // Not a failure: show the countdown instead of an error.
          const seconds = Number(/(\d+) s/.exec(e.message)?.[1] ?? cooldownSeconds)
          setBlockedUntil(Date.now() + seconds * 1000)
        } else {
          setRefreshError(errorMessage(e))
        }
      },
    })
  }

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 text-left font-semibold hover:text-blue-700"
        >
          <span className={cx('inline-block text-xs text-slate-400 transition-transform', !collapsed && 'rotate-90')}>
            ▶
          </span>
          {vendor.name}
        </button>
        <span className="text-sm text-slate-500">
          {robots.length} robot{robots.length === 1 ? '' : 's'} · {online} online
        </span>
        <VendorStatusBadge status={vendor.status} />
        <div className="ml-auto flex items-center gap-3">
          {vendor.capabilities.refresh && (
            <Button
              size="sm"
              variant="secondary"
              disabled={refresh.isPending || waitSeconds > 0}
              onClick={onRefresh}
              title={
                waitSeconds > 0
                  ? `${vendor.name} robots can be refreshed once every ${cooldownSeconds} s to respect the vendor's rate limits`
                  : `Ask ${vendor.name} for the current status of all these robots`
              }
              className="whitespace-nowrap tabular-nums"
            >
              {refresh.isPending ? 'Refreshing…' : waitSeconds > 0 ? `Refresh in ${waitSeconds} s` : 'Refresh'}
            </Button>
          )}
          {isAdmin && (
            <Link to={`/vendors/${vendor.id}`} className="text-sm text-blue-600 hover:underline">
              Configure
            </Link>
          )}
        </div>
      </header>

      {!collapsed && (
        <>
          {refreshError && (
            <div className="border-b border-slate-200 p-3">
              <ErrorBox title={`${vendor.name} refresh failed`}>{refreshError}</ErrorBox>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Robot</th>
                  <th className="px-4 py-2.5 font-medium">Store</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Battery</th>
                  <th className="px-4 py-2.5 font-medium">Current task</th>
                  <th className="px-4 py-2.5 font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {robots.map((robot) => (
                  <RobotRow key={robot.id} robot={robot} Detail={RobotDetail} Actions={RobotActions} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function RobotRow({
  robot,
  Detail,
  Actions,
}: {
  robot: Robot
  Detail?: ComponentType<{ robot: Robot }>
  Actions?: ComponentType<{ robot: Robot }>
}) {
  const state = WORK_STATE[robot.work_state] ?? WORK_STATE.unknown
  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        <div className="font-medium">{robot.name ?? robot.external_id}</div>
        <div className="font-mono text-xs text-slate-500">{robot.external_id}</div>
        {robot.model && <div className="text-xs text-slate-500">{robot.model}</div>}
        {Actions && <Actions robot={robot} />}
      </td>
      <td className="px-4 py-3 text-slate-600">{robot.store_name ?? robot.store_external_id ?? '—'}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cx(
              'size-2.5 shrink-0 rounded-full',
              robot.online === true ? 'bg-green-500' : robot.online === false ? 'bg-slate-300' : 'bg-slate-200',
            )}
            title={robot.online === true ? 'Online' : robot.online === false ? 'Offline' : 'Unknown'}
          />
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {robot.can_be_called === true ? 'Callable' : robot.can_be_called === false ? 'Not callable' : ''}
          {robot.online_type && `${robot.can_be_called !== null ? ' · ' : ''}${robot.online_type}`}
        </div>
        {Detail && <Detail robot={robot} />}
      </td>
      <td className="px-4 py-3">
        <BatteryBar level={robot.battery} charging={robot.charging} />
      </td>
      <td className="px-4 py-3">
        <TaskSummary task={robot.current_task} />
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-slate-600" title={formatDateTime(robot.last_seen_at)}>
        {timeAgo(robot.last_seen_at)}
      </td>
    </tr>
  )
}

function BatteryBar({ level, charging }: { level: number | null; charging: boolean | null }) {
  if (level === null) return <span className="text-slate-400">—</span>
  const pct = Math.max(0, Math.min(100, level))
  return (
    <div className="flex items-center gap-2">
      <div className="h-2.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <div
          className={cx('h-full rounded-full', pct <= 15 ? 'bg-red-500' : pct <= 35 ? 'bg-amber-500' : 'bg-green-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-slate-700">{pct}%</span>
      {charging && <span className="text-xs text-amber-700">charging</span>}
    </div>
  )
}

function TaskSummary({ task }: { task: RobotTask | null }) {
  if (!task) return <span className="text-slate-400">—</span>
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={TASK_TONE[task.state] ?? 'slate'}>{task.state.replace('_', ' ')}</Badge>
        {task.type && <span className="text-xs text-slate-600">{task.type}</span>}
      </div>
      {task.error_message && <div className="text-xs text-red-700">{task.error_message}</div>}
      <div className="text-xs text-slate-400" title={formatDateTime(task.updated_at)}>
        {task.task_no && <span className="font-mono">{task.task_no}</span>} · {timeAgo(task.updated_at)}
      </div>
    </div>
  )
}
