import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useImportSettings, useSaveConnection } from '../../hooks/useElevators'
import { CONNECTION_STATE } from '../../lib/elevators'
import { formatDateTime } from '../../lib/format'
import type { ElevatorsLive, LiftMindConnectionUpdate, LiftMindConnectionView } from '../../types/api'
import { Badge, Button, Card, ErrorBox, TextField, Toggle, errorMessage } from '../ui'

interface Draft {
  enabled: boolean
  mqtt_host: string
  mqtt_port: string
  use_tls: boolean
  client_id_prefix: string
  manufacturer_id: string
  username: string
  password: string
  /** undefined: keep the saved one; null: remove it; string: new PEM. */
  ca_cert: string | null | undefined
}

function draftFrom(c: LiftMindConnectionView): Draft {
  return {
    enabled: c.enabled,
    mqtt_host: c.mqtt_host,
    mqtt_port: String(c.mqtt_port),
    use_tls: c.use_tls,
    client_id_prefix: c.client_id_prefix,
    manufacturer_id: c.manufacturer_id,
    username: c.username,
    password: '',
    ca_cert: undefined,
  }
}

async function readFile(e: ChangeEvent<HTMLInputElement>): Promise<string | null> {
  const file = e.target.files?.[0]
  e.target.value = ''
  return file ? file.text() : null
}

/** LiftMind MQTT connection: status, settings, CA certificate and setting.json import. */
export function ConnectionCard({ connection, live }: { connection: LiftMindConnectionView; live?: ElevatorsLive }) {
  const save = useSaveConnection()
  const importSettings = useImportSettings()
  const [draft, setDraft] = useState(() => draftFrom(connection))
  const [importNote, setImportNote] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const settingsInput = useRef<HTMLInputElement>(null)
  const certInput = useRef<HTMLInputElement>(null)

  // Saving or importing changes the saved settings: start again from them.
  useEffect(() => setDraft(draftFrom(connection)), [connection])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const saved = draftFrom(connection)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const port = Number(draft.mqtt_port)
  const state = CONNECTION_STATE[live?.state ?? 'not_configured']

  function submit(e: FormEvent) {
    e.preventDefault()
    const update: LiftMindConnectionUpdate = {
      enabled: draft.enabled,
      mqtt_host: draft.mqtt_host,
      mqtt_port: port,
      use_tls: draft.use_tls,
      client_id_prefix: draft.client_id_prefix,
      manufacturer_id: draft.manufacturer_id,
      username: draft.username,
      ...(draft.password ? { password: draft.password } : {}),
      ...(draft.ca_cert !== undefined ? { ca_cert: draft.ca_cert } : {}),
    }
    save.mutate(update)
  }

  async function onSettingsFile(e: ChangeEvent<HTMLInputElement>) {
    setImportNote(null)
    setReadError(null)
    const text = await readFile(e)
    if (!text) return
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      setReadError('That file is not valid JSON.')
      return
    }
    importSettings.mutate(json, {
      onSuccess: (r) => {
        setImportNote(
          `Imported: ${r.elevators_created} lift(s) created, ${r.elevators_updated} updated, ${r.robots} robot link(s) added. ` +
            'Manufacturer ID, username and password were saved. Add the floors each lift serves below.',
        )
      },
    })
  }

  const cert = connection.ca_cert
  return (
    <Card
      title="LiftMind connection"
      description="MQTT connection to Owlsome Tech's LiftMind elevator control (D Mode). Ask Owlsome Tech for these details."
      actions={
        <div className="flex items-center gap-2">
          <Badge tone={state.tone}>MQTT: {state.label}</Badge>
          {live?.service && (
            <Badge tone={live.service === 'online' ? 'green' : 'red'}>LiftMind service: {live.service}</Badge>
          )}
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {live?.error && <ErrorBox title="Connection problem">{live.error}</ErrorBox>}

        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <TextField label="MQTT server" placeholder="mqtt.example.com" value={draft.mqtt_host} onChange={(e) => set('mqtt_host', e.target.value)} />
          <TextField label="Port" inputMode="numeric" value={draft.mqtt_port} onChange={(e) => set('mqtt_port', e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Manufacturer ID" value={draft.manufacturer_id} onChange={(e) => set('manufacturer_id', e.target.value)} />
          <TextField
            label="Client ID prefix"
            hint="From Owlsome Tech. The app adds a unique ending, so several copies can connect at once."
            value={draft.client_id_prefix}
            onChange={(e) => set('client_id_prefix', e.target.value)}
          />
          <TextField label="Username" autoComplete="off" value={draft.username} onChange={(e) => set('username', e.target.value)} />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            placeholder={connection.password.set ? '•••••••• (saved; type to replace)' : 'Enter the password'}
            value={draft.password}
            onChange={(e) => set('password', e.target.value)}
          />
        </div>

        <div className="rounded-md border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-700">CA certificate</p>
          <p className="mt-0.5 text-sm text-slate-600">
            {draft.ca_cert === null ? (
              <span className="text-amber-700">Will be removed when you save.</span>
            ) : draft.ca_cert ? (
              <span className="text-blue-700">New certificate selected; it is checked when you save.</span>
            ) : cert ? (
              <>
                {cert.subject} · valid until {formatDateTime(cert.valid_to)}{' '}
                {cert.expired && <Badge tone="red">expired</Badge>}
              </>
            ) : (
              <span className="text-slate-500">None. TLS then trusts only the system's certificate authorities.</span>
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              ref={certInput}
              type="file"
              accept=".pem,.crt,.cer,.txt"
              className="hidden"
              onChange={async (e) => {
                const text = await readFile(e)
                if (text) set('ca_cert', text)
              }}
            />
            <Button variant="secondary" size="sm" onClick={() => certInput.current?.click()}>
              Choose certificate file…
            </Button>
            {(cert || draft.ca_cert) && (
              <Button variant="ghost" size="sm" onClick={() => set('ca_cert', cert ? null : undefined)}>
                Remove
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <Toggle
            checked={draft.use_tls}
            onChange={(v) => set('use_tls', v)}
            label="Use TLS"
            description="Always on for LiftMind. Off only for the local fake (npm run liftmind:mock)."
          />
          <Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Enabled" description="Off disconnects from LiftMind." />
        </div>

        {save.error && <ErrorBox>{errorMessage(save.error)}</ErrorBox>}
        {(importSettings.error || readError) && (
          <ErrorBox title="Import failed">{readError ?? errorMessage(importSettings.error)}</ErrorBox>
        )}
        {importNote && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">{importNote}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!dirty || save.isPending || !(port >= 1 && port <= 65535)}>
            {save.isPending ? 'Saving…' : 'Save & connect'}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(saved)}>
              Discard changes
            </Button>
          )}
          <input ref={settingsInput} type="file" accept=".json,application/json" className="hidden" onChange={onSettingsFile} />
          <Button variant="secondary" className="ml-auto" disabled={importSettings.isPending} onClick={() => settingsInput.current?.click()}>
            {importSettings.isPending ? 'Importing…' : 'Import setting.json…'}
          </Button>
          {live?.client_id && <span className="w-full text-xs text-slate-500">Client ID: {live.client_id}</span>}
        </div>
      </form>
    </Card>
  )
}
