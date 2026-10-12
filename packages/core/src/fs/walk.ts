import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.worktrees']);

/** 递归查找名为 `fileName` 的文件（不跟随软链目录，跳过 node_modules / .git / .worktrees）。返回绝对路径，已排序。 */
export async function findFiles(root: string, fileName: string, maxDepth = 8): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === fileName) out.push(full);
      else if (e.isDirectory() && !SKIP.has(e.name) && depth < maxDepth) await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return out.sort();
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function lexists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

export async function readJson<T = unknown>(p: string): Promise<T | null> {
  const text = await readText(p);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}
