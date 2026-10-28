import { SignJWT, jwtVerify } from 'jose'
import type { Role } from '../../src/types/api'

export const SESSION_COOKIE = 'sr_session'
export const SESSION_TTL_SECONDS = 12 * 60 * 60

export interface SessionClaims {
  sub: string
  username: string
  role: Role
}

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters')
  }
  return new TextEncoder().encode(secret)
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ username: claims.username, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey())
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string') return null
    return { sub: payload.sub, username: String(payload.username), role: payload.role as Role }
  } catch {
    return null
  }
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return rest.join('=') || null
  }
  return null
}

function cookieAttributes(req: Request, maxAge: number): string {
  // Secure cookies need HTTPS; local dev runs on plain http://localhost. Behind a TLS-terminating
  // proxy the server rebuilds req.url from X-Forwarded-Proto (see server/app.ts).
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : ''
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

export function sessionCookie(token: string, req: Request): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(req, SESSION_TTL_SECONDS)}`
}

export function clearSessionCookie(req: Request): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(req, 0)}`
}
