import { timingSafeEqual } from 'node:crypto'
import { endpointForLog, logJson } from '../app'
import { HttpError, handler, json, methodNotAllowed } from '../lib/http'
import { findAdapter } from '../vendors/index'
import {
  type EventRecord,
  getConfigCached,
  headersForLog,
  persistRobots,
  recordEvent,
  updateConfig,
} from '../vendors/store'
import type { VendorAdapter, VendorConfigRow, WebhookInterpretation } from '../vendors/types'

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Run database work after the reply has gone out; failures only reach the server log. */
function inBackground(vendor: string, eventType: string, work: () => Promise<void>): void {
  work().catch((err) =>
    logJson('error', 'callback processing failed', {
      vendor,
      event_type: eventType,
      error: err instanceof Error ? err.message : String(err),
    }),
  )
}

/**
 * Callbacks pushed by vendor clouds (no user session).
 * URL: /api/vendors/:vendor/webhook (and /keenon/webhook, see routes.ts). There is no token in
 * the URL for now, so the vendor's signature (Require signature) is the only proof a callback is
 * genuine. The older /api/vendors/:vendor/webhook/:token URLs keep working; a token, when given,
 * must match.
 *
 * The reply is sent before anything is saved: Keenon's client hangs up on replies that take
 * about a second, which the database round trips did. So a failed save is logged and shown
 * in the callback log, but the vendor still got a 200.
 */
export default handler(
  async (req, params) => {
    if (req.method !== 'POST') methodNotAllowed()
    const started = Date.now()

    // Unknown vendor, disabled vendor or wrong token: 404 without logging, so probes can't fill the log.
    const adapter = findAdapter(params.vendor)
    const config = adapter ? await getConfigCached(adapter.id) : null
    const tokenOk = params.token === undefined || (!!config && tokensMatch(params.token, config.webhook_token))
    if (!adapter || !config || !config.enabled || !tokenOk) {
      throw new HttpError(404, 'Not found')
    }

    const rawBody = await req.text()
    const signature = adapter.verifyWebhook(config, rawBody, req.headers)
    const base = {
      vendor: adapter.id,
      signature: signature.status,
      signature_detail: signature.detail ?? null,
      headers: headersForLog(req.headers),
      endpoint: endpointForLog(req),
      rawBody,
    }

    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      const reply = { error: 'Body must be JSON' }
      const duration_ms = Date.now() - started
      inBackground(adapter.id, 'Invalid JSON', () =>
        recordEvent({
          ...base,
          parsedBody: undefined,
          event_type: 'Invalid JSON',
          robot_external_id: null,
          status: 'failed',
          error: 'Body is not valid JSON',
          duration_ms,
          response_status: 400,
          response_body: reply,
        }),
      )
      return json(reply, { status: 400 })
    }

    const meaning = adapter.interpretWebhook(body)

    if (adapter.requireSignature(config) && signature.status !== 'valid') {
      const reply = { error: 'Invalid signature' }
      const duration_ms = Date.now() - started
      inBackground(adapter.id, meaning.eventType, () =>
        recordEvent({
          ...base,
          parsedBody: body,
          event_type: meaning.eventType,
          robot_external_id: meaning.robotExternalId,
          status: 'rejected',
          error: `Signature ${signature.status}${signature.detail ? `: ${signature.detail}` : ''}`,
          duration_ms,
          response_status: 401,
          response_body: reply,
        }),
      )
      return json(reply, { status: 401 })
    }

    const duration_ms = Date.now() - started
    inBackground(adapter.id, meaning.eventType, () =>
      processCallback(adapter, config, meaning, body, { ...base, duration_ms }),
    )
    return json(adapter.webhookAck, { status: 200 })
  },
  { checkOrigin: false },
)

type CallbackBase = Pick<
  EventRecord,
  'vendor' | 'signature' | 'signature_detail' | 'headers' | 'endpoint' | 'rawBody' | 'duration_ms'
>

/** Save an accepted callback: robot update, callback log, then the vendor's follow-up actions. */
async function processCallback(
  adapter: VendorAdapter,
  config: VendorConfigRow,
  meaning: WebhookInterpretation,
  body: unknown,
  base: CallbackBase,
): Promise<void> {
  const now = new Date().toISOString()
  let status: 'processed' | 'ignored' | 'failed' = meaning.status
  let error = meaning.note ?? null
  try {
    if (meaning.robotExternalId && meaning.patch) {
      await persistRobots(adapter.id, [{ external_id: meaning.robotExternalId, ...meaning.patch }], {
        last_seen_at: now,
      })
    }
  } catch (err) {
    console.error(err)
    status = 'failed'
    error = err instanceof Error ? err.message : 'Failed to update robot'
  }

  await recordEvent({
    ...base,
    parsedBody: body,
    event_type: meaning.eventType,
    robot_external_id: meaning.robotExternalId,
    status,
    error,
    response_status: 200,
    response_body: adapter.webhookAck,
  })
  await updateConfig(adapter.id, { last_callback_at: now })

  if (status !== 'failed' && adapter.onCallback) {
    try {
      await adapter.onCallback({ eventType: meaning.eventType, robotExternalId: meaning.robotExternalId, body }, config)
    } catch (err) {
      logJson('error', 'callback action failed', {
        vendor: adapter.id,
        event_type: meaning.eventType,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
