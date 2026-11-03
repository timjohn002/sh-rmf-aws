import { useMemo, useState } from 'react'
import { ConnectionCard } from '../components/elevators/ConnectionCard'
import { LiftDialog } from '../components/elevators/LiftDialog'
import { LiftsByFloorCard, LiftsCard } from '../components/elevators/LiftsCards'
import { MessagesCard } from '../components/elevators/MessagesCard'
import { StartTestRideDialog, TestRideCard } from '../components/elevators/TestRide'
import { ErrorBox, FullPageSpinner, errorMessage } from '../components/ui'
import { useElevators, useElevatorsLive } from '../hooks/useElevators'
import { useFloors } from '../hooks/useFloors'
import { useRobots } from '../hooks/useRobots'
import { rideFinished } from '../lib/elevators'
import type { Elevator } from '../types/api'

type Editing = { lift: Elevator | null; floorId?: string } | null

/** `/elevators` (admins): LiftMind connection, lifts per floor, queue check and test ride. */
export function ElevatorsPage() {
  const elevators = useElevators()
  const live = useElevatorsLive()
  const floorsQuery = useFloors()
  const robotsQuery = useRobots()
  const [editing, setEditing] = useState<Editing>(null)
  const [testing, setTesting] = useState<Elevator | null>(null)

  const floors = useMemo(() => [...(floorsQuery.data ?? [])].sort((a, b) => b.level - a.level), [floorsQuery.data])
  const robots = useMemo(() => robotsQuery.data?.groups.flatMap((g) => g.robots) ?? [], [robotsQuery.data])

  const loadError = elevators.error ?? floorsQuery.error
  if (loadError) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorBox title="Could not load elevators">
          {errorMessage(loadError)}. If the tables are missing, run <code>supabase/migrations/0007_elevators.sql</code>.
        </ErrorBox>
      </div>
    )
  }

  if (!elevators.data || !floorsQuery.data) return <FullPageSpinner />

  const { connection, elevators: lifts } = elevators.data
  const ride = live.data?.ride ?? null
  const online = live.data?.state === 'online'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <div>
          <h1 className="text-xl font-semibold">Elevators</h1>
          <p className="text-sm text-slate-500">
            Lifts controlled through LiftMind (Owlsome Tech, D Mode). Set up the connection, add the lifts each floor has, and
            try a ride.
          </p>
        </div>

        <ConnectionCard connection={connection} live={live.data} />
        {ride && <TestRideCard ride={ride} lift={lifts.find((l) => l.id === ride.elevator_id)} />}
        <LiftsByFloorCard
          floors={floors}
          lifts={lifts}
          onAdd={(floorId) => setEditing({ lift: null, floorId })}
          onEdit={(lift) => setEditing({ lift })}
        />
        <LiftsCard
          lifts={lifts}
          online={online}
          rideRunning={!!ride && !rideFinished(ride)}
          onEdit={(lift) => setEditing({ lift })}
          onTestRide={setTesting}
        />
        <MessagesCard messages={live.data?.messages ?? []} />
      </div>

      {editing && (
        <LiftDialog
          lift={editing.lift}
          floors={floors}
          robots={robots}
          presetFloorId={editing.floorId}
          onClose={() => setEditing(null)}
        />
      )}
      {testing && <StartTestRideDialog lift={testing} floors={floors} onClose={() => setTesting(null)} />}
    </div>
  )
}
