// Replays the Keenon callback examples from the API document to a webhook URL.
//
//   npm run keenon:callbacks -- --url <callback URL> [--secret <client secret>] [--only RobotWorkState,RobotPowerInfo]
//
// With --secret, each request is signed like Keenon does (X-Signature / X-Nonce / X-Timestamp).

import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { KEENON_CALLBACK_FIXTURES } from '../server/vendors/keenon/fixtures'
import { computeKeenonSignature } from '../server/vendors/keenon/webhook'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    secret: { type: 'string' },
    only: { type: 'string' },
  },
})

if (!values.url) {
  console.error('Usage: npm run keenon:callbacks -- --url <callback URL> [--secret <client secret>] [--only A,B]')
  process.exit(1)
}

const only = values.only?.split(',').map((s) => s.trim())
const entries = Object.entries(KEENON_CALLBACK_FIXTURES).filter(([name]) => !only || only.includes(name))

for (const [name, payload] of entries) {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (values.secret) {
    const nonce = randomBytes(6).toString('hex')
    const timestamp = String(Date.now())
    headers['x-nonce'] = nonce
    headers['x-timestamp'] = timestamp
    headers['x-signature'] = computeKeenonSignature(body, nonce, timestamp, values.secret)
  }
  const res = await fetch(values.url, { method: 'POST', headers, body })
  console.log(`${res.status}  ${name.padEnd(24)} ${await res.text()}`)
}
