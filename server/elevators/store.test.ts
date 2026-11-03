import { describe, expect, it } from 'vitest'
import { certInfo, defaultLiftName, parseSettingsJson, validCaCert } from './store'

// Throwaway self-signed certificate made for these tests (no private key kept), valid until 2126.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBxDCCAWugAwIBAgIUQm6+6QyfKg34NPWZAz1+GvDWofYwCgYIKoZIzj0EAwIw
NzEZMBcGA1UEAwwQVGVzdCBMaWZ0TWluZCBDQTEaMBgGA1UECgwRU3Rhcmh1YiBS
TUYgdGVzdHMwIBcNMjYxMTAzMDI0NjQxWhgPMjEyNjEwMTAwMjQ2NDFaMDcxGTAX
BgNVBAMMEFRlc3QgTGlmdE1pbmQgQ0ExGjAYBgNVBAoMEVN0YXJodWIgUk1GIHRl
c3RzMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHQu5GXzL4ctr+OlJLKnhsvLY
TY1HCkkg1pZFkDGJD6hJLYHPA8VnZeGjCRMChmJ9f/XKzA2sCZyK1sv/q2wdyKNT
MFEwHQYDVR0OBBYEFATteiFX7i6/xx+GDH7CsosuwNjUMB8GA1UdIwQYMBaAFATt
eiFX7i6/xx+GDH7CsosuwNjUMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwID
RwAwRAIgcjOFJ49Yoo3tM66+qWx+cfz2unDpkrgTC7gBilhQL+sCICa2mgx+QGlB
JyfZ8kPGYFLsPdfq630jISQzgpCtasmg
-----END CERTIFICATE-----`

describe('CA certificate', () => {
  it('reads the subject and expiry', () => {
    const info = certInfo(TEST_CA, Date.parse('2030-01-01'))
    expect(info?.subject).toContain('CN=Test LiftMind CA')
    expect(info?.valid_to.startsWith('2126-')).toBe(true)
    expect(info?.expired).toBe(false)
    expect(certInfo(TEST_CA, Date.parse('2200-01-01'))?.expired).toBe(true)
  })

  it('accepts a PEM certificate (with surrounding whitespace) and rejects anything else', () => {
    expect(validCaCert(`\n  ${TEST_CA}  \n`)).toBe(`${TEST_CA}\n`)
    expect(() => validCaCert('not a cert')).toThrow(/PEM/)
    expect(() => validCaCert('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow(/PEM/)
  })

  it('has no info without a certificate', () => {
    expect(certInfo(null)).toBeNull()
  })
})

describe('setting.json import', () => {
  const sample = {
    manufacturer_id: 'm-123',
    username: 'user',
    password: 'pass',
    robots: [
      { uuid: 'rb-1', controllable_elevators: [{ elevator_uuid: 'lc-aaa' }, { elevator_uuid: 'lc-bbb' }] },
      { uuid: 'rb-2', controllable_elevators: [{ elevator_uuid: 'lc-aaa' }] },
    ],
  }

  it('splits it into connection fields and robots per elevator', () => {
    const { connection, robotsByElevator } = parseSettingsJson(sample)
    expect(connection).toEqual({ manufacturer_id: 'm-123', username: 'user', password: 'pass' })
    expect(Object.fromEntries(robotsByElevator)).toEqual({ 'lc-aaa': ['rb-1', 'rb-2'], 'lc-bbb': ['rb-1'] })
  })

  it('rejects files that are not a LiftMind setting.json', () => {
    expect(() => parseSettingsJson({ robots: [] })).toThrow(/manufacturer_id/)
    expect(() => parseSettingsJson('hello')).toThrow(/setting\.json/)
  })

  it('names imported lifts after the end of their UUID', () => {
    expect(defaultLiftName('lc-00000000-1111-2222-3333-44445555beef')).toBe('Lift beef')
  })
})
