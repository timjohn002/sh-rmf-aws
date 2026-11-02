import { useState } from 'react'
import type { SignatureStatus, VendorEventStatus, VendorStatus } from '../../types/api'
import { Badge, Button, type BadgeTone } from '../ui'

// Callback log badges, shared by the Callback log and Live callbacks.
export const EVENT_STATUS_TONE: Record<VendorEventStatus, BadgeTone> = {
  processed: 'green',
  ignored: 'slate',
  rejected: 'red',
  failed: 'red',
}

export const SIGNATURE_TONE: Record<SignatureStatus, BadgeTone> = {
  valid: 'green',
  invalid: 'red',
  missing: 'amber',
  not_checked: 'slate',
}

export const SIGNATURE_LABEL: Record<SignatureStatus, string> = {
  valid: 'signed',
  invalid: 'bad signature',
  missing: 'unsigned',
  not_checked: 'not checked',
}

/** Pretty-printed JSON (or raw text) in a dark code block. */
export function JsonBlock({ title, value }: { title?: string; value: unknown }) {
  return (
    <div>
      {title && <p className="mb-1 font-medium text-slate-700">{title}</p>}
      <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

/** Host of a logged callback endpoint, for compact display. */
export function endpointHost(endpoint: string | null): string {
  if (!endpoint) return '—'
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

const STATUS: Record<VendorStatus, { tone: BadgeTone; label: string }> = {
  not_configured: { tone: 'slate', label: 'Not configured' },
  disabled: { tone: 'amber', label: 'Disabled' },
  connected: { tone: 'green', label: 'Connected' },
  error: { tone: 'red', label: 'Error' },
}

export function VendorStatusBadge({ status }: { status: VendorStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>
}

/** Read-only value with a copy button (e.g. a webhook URL). */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-slate-700">{label}</p>
      <div className="flex gap-1.5">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.target.select()}
          className="block w-full min-w-0 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
