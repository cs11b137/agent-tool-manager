import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AtmError } from '../errors.js';

export const LOCK_STALE_MS = 30_000;

export interface LockHandle {
  release(): Promise<void>;
}

function newToken(): string {
  return `${process.pid} ${randomBytes(8).toString('hex')} ${new Date().toISOString()}`;
}

async function tryCreate(lockPath: string, token: string): Promise<boolean> {
  let fh;
  try {
    fh = await fs.open(lockPath, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    await fh.writeFile(`${token}\n`);
  } finally {
    await fh.close();
  }
  return true;
}

async function readToken(p: string): Promise<string | null> {
  try {
    return (await fs.readFile(p, 'utf8')).trim();
  } catch {
    return null;
  }
}

function locked(lockPath: string, holder: string | null): AtmError {
  return new AtmError('LOCKED', `another atm process is writing (${lockPath}${holder ? `: ${holder}` : ''})`, {
    nextCommand: 'retry after the other atm process finishes',
  });
}

/**
 * 接管过期锁：先把锁文件 rename 到唯一名字（只有一个进程能 rename 成功），
 * 再确认拿到的确实是刚才判定为过期的那份（内容一致），然后删除并重新 `O_EXCL` 创建。
 * 若 rename 到手的是别人刚建的新锁，原样放回并放弃。
 */
async function takeOverStale(lockPath: string, staleToken: string | null, token: string): Promise<boolean> {
  const grabbed = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await fs.rename(lockPath, grabbed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    // 已被别人移走：和其他接管者公平竞争 O_EXCL 创建
    return tryCreate(lockPath, token);
  }
  const got = await readToken(grabbed);
  if (got !== staleToken) {
    // 抢到的是别人刚创建的新锁：放回去（link 不会覆盖已存在的文件）
    await fs.link(grabbed, lockPath).catch(() => undefined);
    await fs.rm(grabbed, { force: true });
    return false;
  }
  await fs.rm(grabbed, { force: true });
  return tryCreate(lockPath, token);
}

/** `O_EXCL` 创建锁文件（内容为唯一 token：pid + 随机数 + 时间）；30s 未刷新视为过期。持有期间每 10s 刷新 mtime。 */
export async function acquireLock(lockPath: string): Promise<LockHandle> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = newToken();
  if (!(await tryCreate(lockPath, token))) {
    let stale = false;
    let holder: string | null = null;
    try {
      holder = await readToken(lockPath);
      const st = await fs.stat(lockPath);
      stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // 刚被释放：再试一次
      if (!(await tryCreate(lockPath, token))) throw locked(lockPath, holder);
      return handle(lockPath, token);
    }
    if (!stale || !(await takeOverStale(lockPath, holder, token))) throw locked(lockPath, holder);
  }
  return handle(lockPath, token);
}

function handle(lockPath: string, token: string): LockHandle {
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
      // 只删除自己的锁：过期后被别人接管的锁不能误删
      if ((await readToken(lockPath)) === token) await fs.rm(lockPath, { force: true });
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
