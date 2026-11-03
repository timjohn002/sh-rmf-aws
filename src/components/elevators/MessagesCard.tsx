import { formatDateTime } from '../../lib/format'
import type { LiftMindMessage } from '../../types/api'
import { Badge, Card } from '../ui'
import { JsonBlock } from '../vendors/common'

function title(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'title' in payload) return String((payload as { title: unknown }).title)
  return typeof payload === 'string' ? payload : '(no title)'
}

/** The latest MQTT messages to and from LiftMind, newest first. */
export function MessagesCard({ messages }: { messages: LiftMindMessage[] }) {
  return (
    <Card title="MQTT messages" description="The latest messages to and from LiftMind on this server (kept in memory, newest first).">
      {messages.length === 0 ? (
        <p className="text-sm text-slate-500">No messages yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {messages.map((m) => (
            <li key={m.id} className="py-2 text-sm">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="w-36 shrink-0 text-slate-500">{formatDateTime(m.at)}</span>
                  <Badge tone={m.direction === 'out' ? 'blue' : 'green'}>{m.direction === 'out' ? 'sent' : 'received'}</Badge>
                  <span className="font-mono text-xs font-medium">{title(m.payload)}</span>
                  <span className="font-mono text-xs text-slate-400">{m.topic}</span>
                </summary>
                <div className="mt-2">
                  <JsonBlock value={m.payload} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
