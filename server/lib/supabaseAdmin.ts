import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const PLAN_BUCKET = 'floor-plans'

let client: SupabaseClient | undefined

/** Service-role Supabase client. Server-side only: bypasses row-level security. */
export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return client
}
