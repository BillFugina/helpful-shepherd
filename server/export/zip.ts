import { crc32, deflateRawSync } from 'node:zlib'

/**
 * A small ZIP writer on Node's built-in zlib, so the export needs no new
 * package. Deflate for every entry (stored when deflate doesn't help), UTF-8
 * names, no ZIP64: the export is held well under 4 GB and 65,535 entries.
 */

export interface ZipEntry {
  name: string
  data: Uint8Array
}

interface Prepared {
  name: Buffer
  crc: number
  method: 0 | 8
  body: Uint8Array
  size: number
}

const UTF8_FLAG = 0x0800

/** MS-DOS date and time, which is what ZIP stores, read in UTC. */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear())
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

export function prepareEntry(entry: ZipEntry): Prepared {
  const name = Buffer.from(entry.name, 'utf8')
  if (!entry.name || entry.name.startsWith('/') || entry.name.split('/').includes('..')) {
    throw new Error(`Bad zip entry name: ${entry.name}`)
  }
  const deflated = deflateRawSync(entry.data, { level: 9 })
  const stored = deflated.length >= entry.data.length
  return {
    name,
    crc: crc32(entry.data) >>> 0,
    method: stored ? 0 : 8,
    body: stored ? entry.data : deflated,
    size: entry.data.length,
  }
}

/** Bytes an entry adds to the archive: local header, body and central directory record. */
export function entrySize(p: Prepared): number {
  return 30 + p.name.length + p.body.length + 46 + p.name.length
}

/** Bytes the archive adds beyond its entries. */
export const ZIP_OVERHEAD = 22

export function writeZip(entries: readonly Prepared[], at = new Date()): Buffer {
  if (entries.length > 0xffff) throw new Error('Too many zip entries')
  const { time, date } = dosDateTime(at)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(e.method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(e.crc, 14)
    local.writeUInt32LE(e.body.length, 18)
    local.writeUInt32LE(e.size, 22)
    local.writeUInt16LE(e.name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, e.name, Buffer.from(e.body.buffer, e.body.byteOffset, e.body.byteLength))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(e.method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(e.crc, 16)
    central.writeUInt32LE(e.body.length, 20)
    central.writeUInt32LE(e.size, 24)
    central.writeUInt16LE(e.name.length, 28)
    // extra, comment, disk start, internal attrs: 0
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, e.name)

    offset += 30 + e.name.length + e.body.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}
