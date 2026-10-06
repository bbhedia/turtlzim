// Zip files, enough of them to move a notebook in and out of the browser: a writer (files stored,
// not compressed: pages are small and this keeps the writer short enough to verify) and a reader
// that also handles deflate, which is what other programs write.
//
// Limits, checked: fewer than 65,535 files, none and no total of 4 GB or more (no Zip64).

export interface ZipEntry {
  /** The path inside the zip, with `/` between folders. */
  path: string;
  bytes: Uint8Array;
  /** Stored as the file's time (default: now). */
  modified?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which zip uses (two-second resolution, from 1980). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length >= 0xffff) throw new Error("too many files for a zip (the limit is 65,534)");
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.bytes);
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const localOffset = offset;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // flags: the name is UTF-8
    local.setUint16(8, 0, true); // method: stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.bytes.length, true);
    local.setUint32(22, entry.bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // no extra field
    push(new Uint8Array(local.buffer));
    push(name);
    push(entry.bytes);

    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, (3 << 8) | 20, true); // made by: Unix, version 2.0
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(10, 0, true);
    head.setUint16(12, time, true);
    head.setUint16(14, date, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, entry.bytes.length, true);
    head.setUint32(24, entry.bytes.length, true);
    head.setUint16(28, name.length, true);
    head.setUint32(38, (0o100644 << 16) >>> 0, true); // a regular file, rw-r--r--
    head.setUint32(42, localOffset, true);
    central.push(new Uint8Array(head.buffer), name);
  }
  const centralStart = offset;
  for (const chunk of central) push(chunk);
  const centralSize = offset - centralStart;
  if (offset >= 0xffffffff) throw new Error("too much data for a zip (the limit is 4 GB)");

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  push(new Uint8Array(end.buffer));

  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The files of a zip. Reads stored and deflated entries and checks each one's CRC; refuses
 * encrypted entries, Zip64, and any other method. Folders (names ending in `/`) are left out.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is at the end, before a comment of up to 64 KB.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error("Zip64 files are not supported");
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("damaged zip: bad directory entry");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/")) continue;
    if (flags & 1) throw new Error(`${path}: encrypted entries are not supported`);
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`${path}: damaged zip: bad file header`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressed);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`${path}: compression method ${method} is not supported`);
    if (data.length !== size) throw new Error(`${path}: damaged zip: wrong size`);
    if (crc32(data) !== crc) throw new Error(`${path}: damaged zip: checksum mismatch`);
    entries.push({ path, bytes: data });
  }
  return entries;
}
