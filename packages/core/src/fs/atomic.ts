import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileChange } from '../types.js';

function tmpName(p: string): string {
  return path.join(path.dirname(p), `.${path.basename(p)}.atm-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
}

/**
 * 写入目标：`p` 是软链时写到它最终指向的文件（不把软链替换成普通文件）；
 * 断链则写到软链指向的路径。
 */
async function writeTarget(p: string): Promise<string> {
  let cur = p;
  for (let i = 0; i < 40; i++) {
    let st;
    try {
      st = await fs.lstat(cur);
    } catch {
      return cur;
    }
    if (!st.isSymbolicLink()) return cur;
    try {
      return await fs.realpath(cur);
    } catch {
      // 断链：沿着链接继续走，最终写到它指向的位置
      cur = path.resolve(path.dirname(cur), await fs.readlink(cur));
    }
  }
  return cur;
}

/** 临时文件 + rename 的原子写入。跟随软链写到真实文件，并保留原文件权限。 */
export async function atomicWrite(p: string, content: string): Promise<void> {
  const target = await writeTarget(p);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let mode: number | null = null;
  try {
    mode = (await fs.stat(target)).mode & 0o7777;
  } catch {
    // 新文件：使用默认权限
  }
  const tmp = tmpName(target);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    if (mode !== null) await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
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
      return created ? () => undoMkdir(p, created) : null;
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

/**
 * 撤销 mkdir：从 `p` 往上逐级非递归 rmdir，直到本次创建的第一层 `created`。
 * 目录里已有别的内容（ENOTEMPTY）时保留，绝不递归删除。
 */
async function undoMkdir(p: string, created: string): Promise<void> {
  let cur = p;
  for (;;) {
    try {
      await fs.rmdir(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
      if (code !== 'ENOENT') throw e;
    }
    if (cur === created || !cur.startsWith(created + path.sep)) return;
    cur = path.dirname(cur);
  }
}

/** 顺序执行；任一步失败则逆序回滚已执行的操作后重新抛出。回滚失败的步骤会附加到错误信息里。 */
export async function applyOps(ops: Op[]): Promise<void> {
  const undo: Array<{ op: Op; run: () => Promise<void> }> = [];
  try {
    for (const op of ops) {
      const u = await applyOne(op);
      if (u) undo.push({ op, run: u });
    }
  } catch (e) {
    const failures: string[] = [];
    for (const u of undo.reverse()) {
      try {
        await u.run();
      } catch (re) {
        failures.push(`${u.op.action} ${u.op.change.relPath}: ${re instanceof Error ? re.message : String(re)}`);
      }
    }
    if (failures.length) {
      const note = ` (rollback incomplete — ${failures.length} step(s) failed: ${failures.join('; ')})`;
      if (e instanceof Error) {
        e.message += note;
        throw e;
      }
      throw new Error(String(e) + note);
    }
    throw e;
  }
}
