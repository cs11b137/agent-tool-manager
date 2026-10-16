import { deflateRawSync } from 'node:zlib';
/** Small stored ZIP builder for deterministic fixtures, including hostile entries. */
export function zipFixture(entries: Array<{ name: string; text: string; mode?: number; size?: number; compress?: boolean }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.text);
    const packed = entry.compress ? deflateRawSync(data) : data;
    const method = entry.compress ? 8 : 0;
    let crc = 0xffffffff;
    for (const b of data) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    crc = (crc ^ 0xffffffff) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14);
    head.writeUInt16LE(method, 8); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(entry.size ?? data.length, 22); head.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(0x314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(crc, 16);
    cd.writeUInt16LE(method, 10); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(entry.size ?? data.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    local.push(head, name, packed); central.push(cd, name); offset += head.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
