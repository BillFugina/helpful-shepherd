import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * App-level encryption for sensitive columns (DOB, TSA/KTN, frequent-flyer
 * numbers). Values are encrypted before they reach the database with a key
 * that lives only in an environment variable, so a leaked backup or a stray
 * query shows ciphertext.
 *
 * Format: v1.<iv>.<tag>.<ciphertext>, each part base64url. AES-256-GCM, with
 * the column name as associated data so a value can't be moved to another
 * column and still decrypt.
 */

const VERSION = 'v1'
const KEY_BYTES = 32

export function parseKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('FIELD_ENCRYPTION_KEY is not set')
  const key = Buffer.from(raw, 'base64url')
  if (key.length !== KEY_BYTES) {
    throw new Error(`FIELD_ENCRYPTION_KEY must be ${KEY_BYTES} bytes, base64url encoded`)
  }
  return key
}

export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url')
}

export function encryptField(plaintext: string, column: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(column, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function decryptField(stored: string, column: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, ...rest] = stored.split('.')
  if (version !== VERSION || !iv || !tag || ciphertext === undefined || rest.length) {
    throw new Error('Unrecognized encrypted field format')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(column, 'utf8'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
}

let cached: Buffer | undefined

/** The app's field key, read from FIELD_ENCRYPTION_KEY on first use. */
export function fieldKey(): Buffer {
  cached ??= parseKey(process.env.FIELD_ENCRYPTION_KEY)
  return cached
}

export function encryptOptional(value: string | null | undefined, column: string, key = fieldKey()): string | null {
  return value ? encryptField(value, column, key) : null
}
