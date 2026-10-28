// Create (or reset the password of) an account directly in Supabase.
// This is also the recovery path if every admin forgets their password.
//
//   npm run create-user -- --username admin --role admin
//   npm run create-user -- --username admin --reset            (new random password)
//   npm run create-user -- --username bob --password 'S3cret!!'
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.

import { parseArgs } from 'node:util'
import {
  generatePassword,
  hashPassword,
  passwordSchema,
  roleSchema,
  usernameSchema,
} from '../server/lib/passwords'
import { db } from '../server/lib/supabaseAdmin'

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    password: { type: 'string' },
    role: { type: 'string', default: 'user' },
    reset: { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

const username = usernameSchema.safeParse(values.username ?? '')
if (!username.success) fail(username.error.issues[0].message)
const role = roleSchema.safeParse(values.role)
if (!role.success) fail('--role must be "admin" or "user"')

const generated = !values.password
const password = values.password ?? generatePassword()
const validPassword = passwordSchema.safeParse(password)
if (!validPassword.success) fail(validPassword.error.issues[0].message)

const passwordHash = await hashPassword(password)

if (values.reset) {
  const { data, error } = await db()
    .from('app_users')
    .update({ password_hash: passwordHash, failed_attempts: 0, locked_until: null })
    .eq('username', username.data)
    .select('id')
  if (error) fail(error.message)
  if (!data.length) fail(`No user named "${username.data}"`)
  console.log(`Password reset for "${username.data}".`)
} else {
  const { error } = await db()
    .from('app_users')
    .insert({ username: username.data, role: role.data, password_hash: passwordHash })
  if (error?.code === '23505') fail(`User "${username.data}" already exists (use --reset to set a new password)`)
  if (error) fail(error.message)
  console.log(`Created ${role.data} "${username.data}".`)
}

if (generated) console.log(`Password: ${password}`)
