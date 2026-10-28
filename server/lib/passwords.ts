import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

const BCRYPT_COST = 12

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, 'Username must be 3-32 characters: letters, numbers, . _ -')

// bcrypt only uses the first 72 bytes of a password.
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')

export const roleSchema = z.enum(['admin', 'user'])

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST)
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

let dummyHash: Promise<string> | undefined

/** Hash to compare against when the username doesn't exist, so timing doesn't reveal it. */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
  return dummyHash
}

export function generatePassword(): string {
  return randomBytes(12).toString('base64url')
}
