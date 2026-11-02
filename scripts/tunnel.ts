// Public ngrok tunnel to the locally running app, so vendor clouds (Keenon) can reach the webhook.
//
//   npm run tunnel       # https://<PUBLIC_SITE_URL host> → http://localhost:8090 (the Podman container)
//   npm run tunnel:dev   # same, → http://localhost:8080 (the API server of `npm run dev`)
//
// The tunnel uses the host of PUBLIC_SITE_URL (.env.local), which must be your ngrok static
// domain, so the callback URL on Vendors → Keenon is the one the tunnel serves.
// scripts/ngrok-policy.yml lets only webhook paths through.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { port: { type: 'string', default: '8090' } } })
const port = Number(values.port)
const policyFile = join(dirname(fileURLToPath(import.meta.url)), 'ngrok-policy.yml')

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid --port: ${values.port}`)

let host: string
try {
  const url = new URL(process.env.PUBLIC_SITE_URL ?? '')
  if (url.protocol !== 'https:') fail('PUBLIC_SITE_URL must start with https://')
  host = url.host
} catch {
  fail('Set PUBLIC_SITE_URL in .env.local to your ngrok static domain, e.g. https://your-name.ngrok-free.dev')
}
if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) fail('PUBLIC_SITE_URL points to this machine; use your ngrok domain.')

console.log(`ngrok: https://${host} → http://localhost:${port} (webhook paths only)`)
const ngrok = spawn('ngrok', ['http', String(port), '--url', host, '--traffic-policy-file', policyFile], {
  stdio: 'inherit',
})
ngrok.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ENOENT') {
    fail(
      'ngrok is not installed. Install it from the Microsoft Store (or ngrok.com/download), ' +
        'then run `ngrok config add-authtoken <your token>`.',
    )
  }
  fail(err.message)
})
ngrok.on('exit', (code) => process.exit(code ?? 0))
