import { timingSafeEqual } from 'node:crypto'
import { HttpError, handler, json, methodNotAllowed } from '../lib/http'
import { findAdapter } from '../vendors/index'
import { headersForLog, loadConfig, persistRobots, recordEvent, updateConfig } from '../vendors/store'

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Callbacks pushed by vendor clouds (no user session).
 * URL: /api/vendors/:vendor/webhook/:token — the token is the shared secret.
 */
export default handler(
  async (req, params) => {
    if (req.method !== 'POST') methodNotAllowed()
    const started = Date.now()

    // Unknown vendor/token or disabled vendor: 404 without logging, so probes can't fill the log.
    const adapter = findAdapter(params.vendor)
    const config = adapter ? await loadConfig(adapter.id) : null
    if (!adapter || !config || !config.enabled || !tokensMatch(params.token ?? '', config.webhook_token)) {
      throw new HttpError(404, 'Not found')
    }

    const rawBody = await req.text()
    const signature = adapter.verifyWebhook(config, rawBody, req.headers)
    const base = {
      vendor: adapter.id,
      signature: signature.status,
      signature_detail: signature.detail ?? null,
      headers: headersForLog(req.headers),
      rawBody,
    }

    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      await recordEvent({
        ...base,
        parsedBody: undefined,
        event_type: 'Invalid JSON',
        robot_external_id: null,
        status: 'failed',
        error: 'Body is not valid JSON',
        duration_ms: Date.now() - started,
      })
      return json({ error: 'Body must be JSON' }, { status: 400 })
    }

    const meaning = adapter.interpretWebhook(body)

    if (adapter.requireSignature(config) && signature.status !== 'valid') {
      await recordEvent({
        ...base,
        parsedBody: body,
        event_type: meaning.eventType,
        robot_external_id: meaning.robotExternalId,
        status: 'rejected',
        error: `Signature ${signature.status}${signature.detail ? `: ${signature.detail}` : ''}`,
        duration_ms: Date.now() - started,
      })
      return json({ error: 'Invalid signature' }, { status: 401 })
    }

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
      duration_ms: Date.now() - started,
    })
    await updateConfig(adapter.id, { last_callback_at: now })

    return json(adapter.webhookAck, { status: status === 'failed' ? 500 : 200 })
  },
  { checkOrigin: false },
)
