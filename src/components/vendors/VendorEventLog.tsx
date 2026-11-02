import { useState } from 'react'
import { useVendorEvent, useVendorEvents, type EventFilters } from '../../hooks/useVendors'
import { formatDateTime, timeAgo } from '../../lib/format'
import { Badge, Button, ErrorBox, Modal, SelectField, Spinner, errorMessage } from '../ui'
import { EVENT_STATUS_TONE, JsonBlock, SIGNATURE_LABEL, SIGNATURE_TONE, endpointHost } from './common'

/** Callback log for one vendor: filterable, auto-refreshing, with a payload viewer. */
export function VendorEventLog({ vendorId }: { vendorId: string }) {
  const [filters, setFilters] = useState<EventFilters>({})
  const [pages, setPages] = useState<string[]>([]) // `before` cursors of older pages
  const [openId, setOpenId] = useState<string | null>(null)
  const latest = useVendorEvents(vendorId, filters)

  function setFilter(next: EventFilters) {
    setFilters(next)
    setPages([])
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          label="Status"
          className="w-40"
          value={filters.status ?? ''}
          onChange={(e) => setFilter({ ...filters, status: e.target.value || undefined })}
          options={[
            { value: '', label: 'All' },
            { value: 'processed', label: 'Processed' },
            { value: 'ignored', label: 'Ignored' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
        <div className="w-56">
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="event-type-filter">
            Type
          </label>
          <input
            id="event-type-filter"
            placeholder="e.g. RobotWorkState"
            value={filters.type ?? ''}
            onChange={(e) => setFilter({ ...filters, type: e.target.value.trim() || undefined })}
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        {latest.isFetching && <Spinner className="mb-2.5 size-4" />}
      </div>

      {latest.error && <ErrorBox>{errorMessage(latest.error)}</ErrorBox>}

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Received</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Robot</th>
              <th className="px-3 py-2 font-medium">Endpoint</th>
              <th className="px-3 py-2 font-medium">Signature</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <EventRows vendorId={vendorId} filters={filters} onOpen={setOpenId} />
          {pages.map((before) => (
            <EventRows key={before} vendorId={vendorId} filters={filters} before={before} onOpen={setOpenId} />
          ))}
        </table>
        {latest.data?.length === 0 && pages.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-slate-500">No callbacks received yet.</p>
        )}
      </div>

      <LoadMore vendorId={vendorId} filters={filters} pages={pages} onMore={(c) => setPages([...pages, c])} />
      <EventDetail eventId={openId} onClose={() => setOpenId(null)} />
    </div>
  )
}

function EventRows({
  vendorId,
  filters,
  before,
  onOpen,
}: {
  vendorId: string
  filters: EventFilters
  before?: string
  onOpen: (id: string) => void
}) {
  const { data } = useVendorEvents(vendorId, filters, before)
  return (
    <tbody className="divide-y divide-slate-100">
      {data?.map((e) => (
        <tr key={e.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(e.id)}>
          <td className="whitespace-nowrap px-3 py-2 text-slate-600" title={formatDateTime(e.received_at)}>
            {timeAgo(e.received_at)}
          </td>
          <td className="px-3 py-2 font-mono text-xs">{e.event_type}</td>
          <td className="px-3 py-2 font-mono text-xs text-slate-600">{e.robot_external_id ?? '—'}</td>
          <td className="px-3 py-2 font-mono text-xs text-slate-600" title={e.endpoint ?? undefined}>
            {endpointHost(e.endpoint)}
          </td>
          <td className="px-3 py-2">
            <Badge tone={SIGNATURE_TONE[e.signature]}>{SIGNATURE_LABEL[e.signature]}</Badge>
          </td>
          <td className="px-3 py-2">
            <Badge tone={EVENT_STATUS_TONE[e.status]}>{e.status}</Badge>
            {e.error && <span className="ml-2 text-xs text-slate-500">{e.error}</span>}
          </td>
        </tr>
      ))}
    </tbody>
  )
}

/** "Load older" uses the oldest event on the last loaded page as the cursor. */
function LoadMore({
  vendorId,
  filters,
  pages,
  onMore,
}: {
  vendorId: string
  filters: EventFilters
  pages: string[]
  onMore: (before: string) => void
}) {
  const { data } = useVendorEvents(vendorId, filters, pages.at(-1))
  if (!data || data.length < 50) return null
  return (
    <Button variant="secondary" size="sm" onClick={() => onMore(data[data.length - 1].received_at)}>
      Load older
    </Button>
  )
}

function EventDetail({ eventId, onClose }: { eventId: string | null; onClose: () => void }) {
  const { data, isPending, error } = useVendorEvent(eventId)
  return (
    <Modal open={!!eventId} title="Callback details" onClose={onClose} size="lg">
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorBox>{errorMessage(error)}</ErrorBox>
      ) : data ? (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-slate-500">Received</dt>
            <dd>{formatDateTime(data.received_at)}</dd>
            <dt className="text-slate-500">Type</dt>
            <dd className="font-mono text-xs">{data.event_type}</dd>
            <dt className="text-slate-500">Robot</dt>
            <dd className="font-mono text-xs">{data.robot_external_id ?? '—'}</dd>
            <dt className="text-slate-500">Endpoint</dt>
            <dd className="break-all font-mono text-xs">{data.endpoint ?? '—'}</dd>
            <dt className="text-slate-500">Signature</dt>
            <dd>
              {SIGNATURE_LABEL[data.signature]}
              {data.signature_detail && <span className="text-slate-500"> ({data.signature_detail})</span>}
            </dd>
            <dt className="text-slate-500">Result</dt>
            <dd>
              {data.status}
              {data.error && <span className="text-slate-500"> ({data.error})</span>}
            </dd>
            <dt className="text-slate-500">Response</dt>
            <dd>
              {data.response_status ?? '—'}
              {data.duration_ms !== null && <span className="text-slate-500"> in {data.duration_ms} ms</span>}
            </dd>
          </dl>
          <JsonBlock title="Body" value={data.body ?? data.body_text} />
          {data.response_body !== null && data.response_body !== undefined && (
            <JsonBlock title="Response" value={data.response_body} />
          )}
          <JsonBlock title="Headers" value={data.headers} />
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
