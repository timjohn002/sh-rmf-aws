import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { CopyField, VendorStatusBadge } from '../../components/vendors/common'
import { LiveCallbacks } from '../../components/vendors/LiveCallbacks'
import { VendorEventLog } from '../../components/vendors/VendorEventLog'
import {
  Button,
  Card,
  ErrorBox,
  FullPageSpinner,
  SelectField,
  TextField,
  Toggle,
  errorMessage,
} from '../../components/ui'
import {
  useSyncVendor,
  useTestVendor,
  useUpdateVendor,
  useVendorConfig,
} from '../../hooks/useVendors'
import { formatDateTime, formatDuration, timeAgo } from '../../lib/format'
import type { VendorConfigView } from '../../types/api'
import { KeenonRobotMapsCard } from './KeenonRobotMapsCard'
import { KEENON_GRANT_TYPE, KEENON_REGIONS, type KeenonRegion, type KeenonSettings } from './shared'

type Config = VendorConfigView<KeenonSettings>

const REGION_OPTIONS = [
  ...Object.entries(KEENON_REGIONS).map(([value, r]) => ({ value, label: `${r.label} (${r.baseUrl})` })),
  { value: 'custom', label: 'Custom URL' },
]

export function KeenonConfig({ vendorId }: { vendorId: string }) {
  const { data: config, isPending, error } = useVendorConfig<KeenonSettings>(vendorId)
  if (isPending) return <FullPageSpinner />
  if (error) return <ErrorBox title="Could not load the Keenon configuration">{errorMessage(error)}</ErrorBox>

  return (
    <div className="space-y-4">
      <div>
        <Link to="/vendors" className="text-sm text-blue-600 hover:underline">
          ← Robot vendors
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{config.name}</h1>
          <VendorStatusBadge status={config.status} />
        </div>
        <p className="text-sm text-slate-500">{config.description}</p>
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <strong>IP whitelist:</strong> Keenon only accepts API calls from whitelisted IP addresses. Test connection,
        Sync and robot Refresh only work when this app runs on your whitelisted network (for example{' '}
        <code className="rounded bg-amber-100 px-1">npm run dev</code> in the office). Callbacks from Keenon are not
        affected.
      </div>

      <ConnectionCard config={config} />
      <StoresCard config={config} />
      <KeenonRobotMapsCard />
      <CallbacksCard config={config} />
      <LiveCallbacks vendorId={config.id} />
      <Card title="Callback log" description="Every callback Keenon sends, kept for 30 days. Click a row to see the payload.">
        <VendorEventLog vendorId={config.id} />
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

interface ConnectionDraft {
  enabled: boolean
  region: KeenonRegion
  custom_base_url: string
  client_id: string
  client_secret: string
}

function draftFrom(config: Config): ConnectionDraft {
  return {
    enabled: config.enabled,
    region: config.settings.region,
    custom_base_url: config.settings.custom_base_url,
    client_id: config.settings.client_id,
    client_secret: '',
  }
}

function ConnectionCard({ config }: { config: Config }) {
  const update = useUpdateVendor<KeenonSettings>(config.id)
  const test = useTestVendor(config.id)
  const [draft, setDraft] = useState(() => draftFrom(config))
  const secret = config.secrets.client_secret
  const [replacingSecret, setReplacingSecret] = useState(!secret?.set)

  const dirty =
    draft.enabled !== config.enabled ||
    draft.region !== config.settings.region ||
    draft.custom_base_url !== config.settings.custom_base_url ||
    draft.client_id !== config.settings.client_id ||
    draft.client_secret !== ''

  function set<K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) {
    test.reset()
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function save(): Promise<boolean> {
    try {
      const saved = await update.mutateAsync({
        enabled: draft.enabled,
        settings: { region: draft.region, custom_base_url: draft.custom_base_url, client_id: draft.client_id },
        secrets: draft.client_secret ? { client_secret: draft.client_secret } : undefined,
      })
      setDraft(draftFrom(saved))
      setReplacingSecret(!saved.secrets.client_secret?.set)
      return true
    } catch {
      return false
    }
  }

  async function onTest() {
    if (dirty && !(await save())) return
    test.mutate()
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void save()
  }

  return (
    <Card title="Connection" description="Keenon Open Platform credentials. Keenon issues the client ID and secret.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Toggle
          checked={draft.enabled}
          onChange={(v) => set('enabled', v)}
          label="Enabled"
          description="When off, Keenon callbacks are refused (404) and robots are not synced on a schedule."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Region (API base URL)"
            value={draft.region}
            onChange={(e) => set('region', e.target.value as KeenonRegion)}
            options={REGION_OPTIONS}
          />
          {draft.region === 'custom' && (
            <TextField
              label="Custom base URL"
              placeholder="https://…"
              value={draft.custom_base_url}
              onChange={(e) => set('custom_base_url', e.target.value)}
              required
            />
          )}
          <TextField
            label="Client ID"
            autoComplete="off"
            value={draft.client_id}
            onChange={(e) => set('client_id', e.target.value)}
          />
          {replacingSecret ? (
            <div>
              <TextField
                label="Client secret"
                type="password"
                autoComplete="new-password"
                placeholder={secret?.set ? 'Enter a new secret' : 'Enter the client secret'}
                value={draft.client_secret}
                onChange={(e) => set('client_secret', e.target.value)}
                hint="Stored on the server only. It is never shown again."
              />
              {secret?.set && (
                <button
                  type="button"
                  className="mt-1 text-xs text-blue-600 hover:underline"
                  onClick={() => {
                    set('client_secret', '')
                    setReplacingSecret(false)
                  }}
                >
                  Keep the current secret
                </button>
              )}
            </div>
          ) : (
            <div>
              <p className="mb-1 text-sm font-medium text-slate-700">Client secret</p>
              <div className="flex items-center gap-2">
                <span className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-600">
                  ••••••••{secret?.last4}
                </span>
                <Button variant="secondary" size="sm" onClick={() => setReplacingSecret(true)}>
                  Replace
                </Button>
              </div>
            </div>
          )}
          <TextField
            label="Grant type"
            value={KEENON_GRANT_TYPE}
            readOnly
            disabled
            hint="Fixed by Keenon. Sent automatically when requesting a token."
          />
        </div>

        {update.error && <ErrorBox>{errorMessage(update.error)}</ErrorBox>}
        {test.error && <ErrorBox title="Connection failed">{errorMessage(test.error)}</ErrorBox>}
        {test.data && (
          <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
            <p className="font-medium">
              Connected. Access token valid for {formatDuration(test.data.token_expires_in)}.
            </p>
            <p>
              {test.data.stores.length} store{test.data.stores.length === 1 ? '' : 's'} found
              {test.data.stores.length > 0 && `: ${test.data.stores.map((s) => s.name ?? s.external_id).join(', ')}`}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            variant="secondary"
            disabled={test.isPending || update.isPending || !draft.client_id || (!secret?.set && !draft.client_secret)}
            onClick={onTest}
          >
            {test.isPending ? 'Testing…' : dirty ? 'Save & test connection' : 'Test connection'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Stores & robots
// ---------------------------------------------------------------------------

function StoresCard({ config }: { config: Config }) {
  const update = useUpdateVendor<KeenonSettings>(config.id)
  const sync = useSyncVendor(config.id)
  const selected = config.settings.store_ids
  const configured = config.status !== 'not_configured'

  function toggleStore(id: string, on: boolean) {
    const next = on ? [...selected, id] : selected.filter((s) => s !== id)
    update.mutate({ settings: { store_ids: next } })
  }

  return (
    <Card
      title="Stores & robots"
      description="Keenon groups robots by store. Choose which stores' robots appear in this app."
      actions={
        <Button disabled={!configured || sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? 'Syncing…' : 'Sync now'}
        </Button>
      }
    >
      <div className="space-y-3">
        {config.stores.length === 0 ? (
          <p className="text-sm text-slate-500">No stores yet. Save the connection, then click Sync now.</p>
        ) : (
          <div>
            <p className="mb-2 text-xs text-slate-500">
              {selected.length === 0 ? 'No store selected: robots from all stores are synced.' : `${selected.length} selected.`}
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {config.stores.map((store) => (
                <li key={store.external_id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-2.5 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.includes(store.external_id)}
                      disabled={update.isPending}
                      onChange={(e) => toggleStore(store.external_id, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{store.name ?? store.external_id}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {store.external_id}
                        {store.address && ` · ${store.address}`}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {update.error && <ErrorBox>{errorMessage(update.error)}</ErrorBox>}
        {sync.error && <ErrorBox title="Sync failed">{errorMessage(sync.error)}</ErrorBox>}
        {sync.data && (
          <p className="text-sm text-green-800">
            Synced {sync.data.stores} store{sync.data.stores === 1 ? '' : 's'} and {sync.data.robots} robot
            {sync.data.robots === 1 ? '' : 's'}.
          </p>
        )}
        {!sync.error && config.last_sync_error && (
          <ErrorBox title="Last sync failed">{config.last_sync_error}</ErrorBox>
        )}

        <p className="text-sm text-slate-600">
          Last sync: <span title={formatDateTime(config.last_sync_at)}>{timeAgo(config.last_sync_at)}</span> ·{' '}
          <Link to="/robots" className="text-blue-600 hover:underline">
            {config.robot_count} robot{config.robot_count === 1 ? '' : 's'}
          </Link>
        </p>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

function CallbacksCard({ config }: { config: Config }) {
  const update = useUpdateVendor<KeenonSettings>(config.id)
  const isLocalUrl = /\/\/(localhost|127\.0\.0\.1)/.test(config.webhook_url)

  return (
    <Card
      title="Callbacks (webhooks)"
      description="Keenon Cloud pushes robot status, battery, work state and task updates to this URL."
    >
      <div className="space-y-4">
        <CopyField label="Callback URL" value={config.webhook_url} />
        {isLocalUrl && (
          <ErrorBox>
            This URL points to your computer, which Keenon cannot reach. Set <code>PUBLIC_SITE_URL</code> in{' '}
            <code>.env.local</code> to the public URL: your ngrok domain (<code>npm run tunnel</code>) or the live site.
          </ErrorBox>
        )}
        {!config.settings.require_signature && (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
            This URL contains no secret, so anyone who knows it can send callbacks. Turn on{' '}
            <strong>Require signature</strong> once Keenon has enabled callback signing.
          </p>
        )}
        {!config.enabled && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The integration is disabled, so callbacks are currently refused. Turn on <strong>Enabled</strong> above.
          </p>
        )}

        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>Copy the callback URL.</li>
          <li>
            Configure it as the webhook address on the Keenon Open Platform (scenario <code>openAdapt</code> for
            elevator riding), or send it to Keenon technical support.
          </li>
          <li>Watch Live callbacks below. The first callbacks usually arrive when a robot changes state.</li>
        </ol>

        <Toggle
          checked={config.settings.require_signature}
          disabled={update.isPending}
          onChange={(v) => update.mutate({ settings: { require_signature: v } })}
          label="Require signature"
          description="Only accept callbacks with a valid X-Signature (MD5 with your client secret). Ask Keenon support to enable callback signing first, or every callback will be rejected."
        />
        {update.error && <ErrorBox>{errorMessage(update.error)}</ErrorBox>}

        <p className="text-sm text-slate-600">
          Last callback received:{' '}
          <span title={formatDateTime(config.last_callback_at)}>{timeAgo(config.last_callback_at)}</span>
        </p>
      </div>
    </Card>
  )
}
