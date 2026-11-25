import { describe, expect, it } from 'vitest'
import { decryptField, encryptField, generateKey, parseKey } from '../server/crypto/fields.js'

const key = parseKey(generateKey())

describe('field encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptField('1988-03-14', 'person.dob', key)
    const b = encryptField('1988-03-14', 'person.dob', key)
    expect(a).not.toBe(b)
    expect(a).not.toContain('1988')
    expect(decryptField(a, 'person.dob', key)).toBe('1988-03-14')
  })

  it('refuses a value moved to another column', () => {
    const stored = encryptField('TT0000101', 'person.tsa_ktn', key)
    expect(() => decryptField(stored, 'person.dob', key)).toThrow()
  })

  it('refuses a tampered value', () => {
    const [v, iv, tag, ct] = encryptField('secret', 'c', key).split('.')
    const flipped = Buffer.from(ct!, 'base64url')
    flipped[0] = flipped[0]! ^ 1
    expect(() => decryptField([v, iv, tag, flipped.toString('base64url')].join('.'), 'c', key)).toThrow()
  })

  it('refuses the wrong key', () => {
    const stored = encryptField('secret', 'c', key)
    expect(() => decryptField(stored, 'c', parseKey(generateKey()))).toThrow()
  })

  it('validates the key', () => {
    expect(() => parseKey(undefined)).toThrow(/not set/)
    expect(() => parseKey('short')).toThrow(/32 bytes/)
  })
})
