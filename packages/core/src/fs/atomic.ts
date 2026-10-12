import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileChange } from '../types.js';

function tmpName(p: string): string {
  return path.join(path.dirname(p), `.${path.basename(p)}.atm-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
}

/** 临时文件 + rename 的原子写入。 */
export async function atomicWrite(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = tmpName(p);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, p);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** 原子替换软链（先建临时软链再 rename 覆盖）。 */
export async function replaceSymlink(p: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = tmpName(p);
  await fs.symlink(target, tmp);
  try {
    await fs.rename(tmp, p);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** 内部变更操作：FileChange + 如何落盘。 */
export interface Op {
  change: FileChange;
  action: 'write' | 'delete' | 'symlink' | 'unlink' | 'mkdir' | 'rmdir' | 'move' | 'exec' | 'none';
  /** move 的来源路径 */
  from?: string;
  exec?: () => Promise<void>;
  undo?: () => Promise<void>;
}

async function applyOne(op: Op): Promise<(() => Promise<void>) | null> {
  const { change } = op;
  const p = change.path;
  switch (op.action) {
    case 'write': {
      await atomicWrite(p, change.after ?? '');
      const before = change.before;
      return before === null ? () => fs.rm(p, { force: true }) : () => atomicWrite(p, before);
    }
    case 'delete': {
      await fs.rm(p, { force: true });
      const before = change.before;
      return before === null ? null : () => atomicWrite(p, before);
    }
    case 'symlink': {
      await replaceSymlink(p, change.target ?? change.after ?? '');
      const before = change.before;
      return before === null ? () => fs.rm(p, { force: true }) : () => replaceSymlink(p, before);
    }
    case 'unlink': {
      await fs.unlink(p);
      const before = change.before;
      return before === null ? null : () => replaceSymlink(p, before);
    }
    case 'mkdir': {
      const created = await fs.mkdir(p, { recursive: true });
      return created ? () => fs.rm(created, { recursive: true, force: true }) : null;
    }
    case 'rmdir': {
      await fs.rmdir(p);
      return () => fs.mkdir(p, { recursive: true }).then(() => undefined);
    }
    case 'move': {
      const from = op.from!;
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.rename(from, p);
      return () => fs.rename(p, from);
    }
    case 'exec': {
      await op.exec?.();
      return op.undo ?? null;
    }
    case 'none':
      return null;
  }
}

/** 顺序执行；任一步失败则逆序回滚已执行的操作后重新抛出。 */
export async function applyOps(ops: Op[]): Promise<void> {
  const undo: Array<() => Promise<void>> = [];
  try {
    for (const op of ops) {
      const u = await applyOne(op);
      if (u) undo.push(u);
    }
  } catch (e) {
    for (const u of undo.reverse()) {
      try {
        await u();
      } catch {
        // 尽力回滚
      }
    }
    throw e;
  }
}
