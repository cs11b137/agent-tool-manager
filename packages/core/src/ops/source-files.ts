import fs from 'node:fs/promises';
import path from 'node:path';
import { fromBufferPromise } from 'yauzl';
import { AtmError } from '../errors.js';

export const MAX_EXPANDED = 50 * 1024 * 1024;
export const MAX_ENTRIES = 2000;
const invalid = (message: string) => new AtmError('INVALID_MANIFEST', message);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface PackageFile { content: Buffer; executable: boolean }

export async function readZip(bytes: Buffer, signal?: AbortSignal): Promise<Map<string, PackageFile>> {
  let zip;
  try { zip = await fromBufferPromise(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }); }
  catch { throw invalid('工具包不是有效的 ZIP 文件'); }
  const files = new Map<string, PackageFile>();
  const names = new Set<string>();
  let total = 0;
  try {
    if (zip.entryCount > MAX_ENTRIES) throw invalid('工具包最多包含 2000 个文件和目录');
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      const name = entry.fileName;
      validateSourcePath(name.replace(/\/$/, ''));
      const segments = name.split('/');
      const key = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
      if (names.has(key)) throw invalid(`工具包包含重复路径：${name}`);
      names.add(key);
      const mode = entry.externalFileAttributes >>> 16;
      const type = mode & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) throw invalid(`工具包不能包含软链或特殊文件：${name}`);
      if (entry.isEncrypted()) throw invalid('不支持加密 ZIP 工具包');
      total += entry.uncompressedSize;
      if (total > MAX_EXPANDED) throw invalid('工具包解压后不能超过 50 MB');
      if (name.endsWith('/')) continue;
      if (type === 0o040000) throw invalid(`目录条目格式无效：${name}`);
      if (segments.some((s) => ['.git', 'node_modules', '__macosx'].includes(s.toLowerCase())) || segments.at(-1) === '.DS_Store') continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > entry.uncompressedSize || size > MAX_EXPANDED) { stream.destroy(); throw invalid('工具包解压大小不匹配'); }
        chunks.push(Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);
      if (crc32(content) !== entry.crc32) throw invalid(`工具包文件校验失败：${name}`);
      files.set(name, { content, executable: !!(mode & 0o111) });
    }
    return files;
  } catch (e) {
    if (e instanceof AtmError) throw e;
    throw invalid(`无法读取 ZIP 工具包：${(e as Error).message}`);
  } finally { zip.close(); }
}


export function validateSourcePath(name: string): void {
  const segments = name.split('/');
  if (!name || segments.some((s) => !s || s === '.' || s === '..' || /[\x00-\x1f<>:"\\|?*]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw invalid(`工具路径无效：${name}`);
}
export async function readDirectory(directory: string, signal?: AbortSignal): Promise<Map<string, PackageFile>> {
  const root = await fs.realpath(directory);
  if (!(await fs.stat(root)).isDirectory()) throw invalid('请选择工具目录');
  const files = new Map<string, PackageFile>();
  const names = new Set<string>();
  let count = 0, total = 0;
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (['.git', 'node_modules', '__MACOSX', '.DS_Store', '.venv', '__pycache__'].includes(entry.name)) continue;
      if (++count > MAX_ENTRIES) throw invalid('工具来源最多包含 2000 个文件和目录');
      const file = path.join(dir, entry.name), rel = path.relative(root, file).split(path.sep).join('/');
      validateSourcePath(rel);
      const key = rel.normalize('NFC').toLowerCase();
      if (names.has(key)) throw invalid(`工具来源包含重复路径：${rel}`);
      names.add(key);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw invalid(`工具目录不能包含软链或特殊文件：${rel}`);
      if (entry.isDirectory()) { await walk(file); continue; }
      const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || total + stat.size > MAX_EXPANDED) throw invalid('工具来源不能超过 50 MB');
        // Bound reads even when the file grows after stat.
        const chunks: Buffer[] = [];
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          total += chunk.length;
          if (total > MAX_EXPANDED) throw invalid('工具来源不能超过 50 MB');
          chunks.push(Buffer.from(chunk));
        }
        files.set(rel, { content: Buffer.concat(chunks), executable: !!(stat.mode & 0o111) });
      } finally { await handle.close(); }
    }
  }
  await walk(root);
  return files;
}
