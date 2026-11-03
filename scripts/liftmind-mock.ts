// A fake LiftMind for local testing: an MQTT broker with a virtual elevator, no TLS, no login.
//
//   npm run liftmind:mock            → mqtt://localhost:1883
//
// On the Elevators page set host "localhost", port 1883, TLS off, any manufacturer ID.
// The lift takes LIFTMIND_MOCK_TRAVEL_MS (default 3000) to reach each floor.

import { createServer } from 'node:net'
import { Aedes } from 'aedes'
import { attachVirtualElevator } from '../server/elevators/liftmind/virtualElevator'

const PORT = Number(process.env.LIFTMIND_MOCK_PORT ?? 1883)

const broker = await Aedes.createBroker()
attachVirtualElevator(broker, {
  travelMs: Number(process.env.LIFTMIND_MOCK_TRAVEL_MS ?? 3_000),
  log: (line) => console.log(`${new Date().toLocaleTimeString()}  ${line}`),
})
broker.on('client', (client) => console.log(`client connected: ${client.id}`))
broker.on('clientDisconnect', (client) => console.log(`client disconnected: ${client.id}`))

createServer(broker.handle).listen(PORT, () => {
  console.log(`Fake LiftMind (virtual elevator) on mqtt://localhost:${PORT}`)
})
