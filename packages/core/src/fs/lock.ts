import fs from 'node:fs/promises';
import path from 'node:path';
import { AtmError } from '../errors.js';

export const LOCK_STALE_MS = 30_000;

export interface LockHandle {
  release(): Promise<void>;
}

async function tryCreate(lockPath: string): Promise<boolean> {
  try {
    const fh = await fs.open(lockPath, 'wx');
    try {
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    } finally {
      await fh.close();
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** `O_EXCL` 创建锁文件；30s 未刷新视为过期。持有期间每 10s 刷新 mtime。 */
export async function acquireLock(lockPath: string): Promise<LockHandle> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  if (!(await tryCreate(lockPath))) {
    let stale = false;
    let holder = '';
    try {
      const st = await fs.stat(lockPath);
      stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
      holder = (await fs.readFile(lockPath, 'utf8')).trim();
    } catch {
      stale = true;
    }
    if (stale) await fs.rm(lockPath, { force: true });
    if (!stale || !(await tryCreate(lockPath))) {
      throw new AtmError('LOCKED', `another atm process is writing (${lockPath}${holder ? `: ${holder}` : ''})`, {
        nextCommand: 'retry after the other atm process finishes',
      });
    }
  }
  const timer = setInterval(() => {
    const now = new Date();
    fs.utimes(lockPath, now, now).catch(() => undefined);
  }, 10_000);
  timer.unref();
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await fs.rm(lockPath, { force: true });
    },
  };
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
