import { beforeAll, describe, expect, it } from 'vitest'
import { hashPassword, usernameSchema, verifyPassword } from './passwords'
import { SESSION_COOKIE, readSessionCookie, sessionCookie, signSession, verifySession } from './session'

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-characters-long'
})

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('correct horse')
    expect(hash).not.toContain('correct horse')
    expect(await verifyPassword('correct horse', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('normalizes usernames to lowercase', () => {
    expect(usernameSchema.parse('  Admin ')).toBe('admin')
    expect(usernameSchema.safeParse('a').success).toBe(false)
    expect(usernameSchema.safeParse('bad name').success).toBe(false)
  })
})

describe('session', () => {
  it('signs and verifies a token', async () => {
    const token = await signSession({ sub: 'u1', username: 'admin', role: 'admin' })
    expect(await verifySession(token)).toEqual({ sub: 'u1', username: 'admin', role: 'admin' })
  })

  it('rejects a tampered token', async () => {
    const token = await signSession({ sub: 'u1', username: 'bob', role: 'user' })
    const [h, , s] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'u1', username: 'bob', role: 'admin' })).toString('base64url')
    expect(await verifySession(`${h}.${forged}.${s}`)).toBeNull()
  })

  it('reads the cookie back and only marks it Secure over https', () => {
    const cookie = sessionCookie('abc.def.ghi', new Request('https://example.com/api/auth/login'))
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(sessionCookie('x', new Request('http://localhost:8888/'))).not.toContain('Secure')

    const req = new Request('https://example.com', { headers: { cookie: `a=1; ${SESSION_COOKIE}=abc.def.ghi` } })
    expect(readSessionCookie(req)).toBe('abc.def.ghi')
  })
})
