import fs from 'node:fs/promises';
import path from 'node:path';

export type LinkState =
  | { kind: 'missing' }
  | { kind: 'symlink'; target: string; resolved: string; broken: boolean }
  | { kind: 'dir' }
  | { kind: 'file' };

export async function linkState(p: string): Promise<LinkState> {
  let st;
  try {
    st = await fs.lstat(p);
  } catch {
    return { kind: 'missing' };
  }
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(p);
    const resolved = path.resolve(path.dirname(p), target);
    let broken = false;
    try {
      await fs.stat(p);
    } catch {
      broken = true;
    }
    return { kind: 'symlink', target, resolved, broken };
  }
  return st.isDirectory() ? { kind: 'dir' } : { kind: 'file' };
}
