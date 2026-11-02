import { useEffect, useRef, useState } from 'react'
import { useLiveVendorEvents } from '../../hooks/useVendors'
import { formatDateTime, timeAgo } from '../../lib/format'
import type { VendorEvent } from '../../types/api'
import { Badge, Button, Card, ErrorBox, Spinner, errorMessage } from '../ui'
import { EVENT_STATUS_TONE, JsonBlock, SIGNATURE_LABEL, SIGNATURE_TONE } from './common'

const HIGHLIGHT_MS = 5_000

/** The newest callbacks with their payloads, refreshed every few seconds (handy while testing). */
export function LiveCallbacks({ vendorId }: { vendorId: string }) {
  const [live, setLive] = useState(true)
  const { data, error, isFetching } = useLiveVendorEvents(vendorId, live)
  const fresh = useNewIds(data)

  return (
    <Card
      title="Live callbacks"
      description="The 20 most recent callbacks with their payloads and our reply, refreshed every 3 s."
      actions={
        <div className="flex items-center gap-2">
          {live && isFetching && <Spinner className="size-4" />}
          <Button variant="secondary" size="sm" onClick={() => setLive(!live)}>
            {live ? 'Pause' : 'Resume'}
          </Button>
        </div>
      }
    >
      {error && <ErrorBox>{errorMessage(error)}</ErrorBox>}
      {!live && <p className="mb-3 text-sm text-amber-700">Paused. New callbacks are still logged.</p>}
      {data?.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-500">
          Waiting for callbacks… Keenon sends one when a robot changes state.
        </p>
      )}
      <ul className="space-y-2">
        {data?.map((e) => <LiveCallback key={e.id} event={e} fresh={fresh.has(e.id)} />)}
      </ul>
    </Card>
  )
}

/** Ids that arrived after the first load, for a few seconds after they appear. */
function useNewIds(events: VendorEvent[] | undefined): Set<string> {
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!events) return
    if (!seen.current) {
      seen.current = new Set(events.map((e) => e.id))
      return
    }
    const added = events.filter((e) => !seen.current!.has(e.id)).map((e) => e.id)
    if (!added.length) return
    for (const id of added) seen.current.add(id)
    setFresh(new Set(added))
    const timer = setTimeout(() => setFresh(new Set()), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [events])

  return fresh
}

function LiveCallback({ event: e, fresh }: { event: VendorEvent; fresh: boolean }) {
  return (
    <li
      className={`rounded-md border p-3 transition-colors duration-1000 ${
        fresh ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-slate-600" title={formatDateTime(e.received_at)}>
          {timeAgo(e.received_at)}
        </span>
        <span className="font-mono text-xs font-medium">{e.event_type}</span>
        {e.robot_external_id && <span className="font-mono text-xs text-slate-500">{e.robot_external_id}</span>}
        <Badge tone={SIGNATURE_TONE[e.signature]}>{SIGNATURE_LABEL[e.signature]}</Badge>
        <Badge tone={EVENT_STATUS_TONE[e.status]}>{e.status}</Badge>
        <span className="text-xs text-slate-500">replied {e.response_status ?? '—'}</span>
        {fresh && <Badge tone="amber">new</Badge>}
      </div>
      <p className="mt-1 break-all font-mono text-xs text-slate-500">{e.endpoint ?? 'Endpoint not recorded'}</p>
      {e.error && <p className="mt-1 text-xs text-slate-500">{e.error}</p>}

      <details open className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-slate-600">Payload</summary>
        <div className="mt-1">
          <JsonBlock value={e.body ?? e.body_text} />
        </div>
      </details>
      {e.response_body !== null && e.response_body !== undefined && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">Reply</summary>
          <div className="mt-1">
            <JsonBlock value={e.response_body} />
          </div>
        </details>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-xs font-medium text-slate-600">Headers</summary>
        <div className="mt-1">
          <JsonBlock value={e.headers} />
        </div>
      </details>
    </li>
  )
}
