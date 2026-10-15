import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { createAtm, type Atm, type AtmEvent } from '../src/index.js';

const temps: string[] = [];

afterEach(async () => {
  for (const t of temps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

export async function mkTmp(prefix = 'atm-test-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

export async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

export async function writeFiles(base: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) await write(path.join(base, rel), content);
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function skillMd(name: string | null, description: string): string {
  return `---\n${name ? `name: ${name}\n` : ''}description: ${description}\n---\n\n# ${name ?? 'skill'}\n`;
}

export interface Remote {
  bare: string;
  work: string;
  /** 写文件 → commit → push，返回新 commit */
  commit(files: Record<string, string>, message?: string): Promise<string>;
}

/** 建一个本地 bare 仓库 + 工作克隆，推入初始文件。 */
export async function makeRemote(base: string, name: string, files: Record<string, string>): Promise<Remote> {
  const bare = path.join(base, 'remotes', `${name}.git`);
  const work = path.join(base, 'remotes-work', name);
  await fs.mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  await fs.mkdir(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', bare);
  const commit = async (f: Record<string, string>, message = 'update') => {
    await writeFiles(work, f);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    git(work, 'push', '-q', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  await commit(files, 'init');
  return { bare, work, commit };
}

export interface Env {
  base: string;
  home: string;
  root: string;
  registry: string;
  events: AtmEvent[];
  atm: Atm;
  project(name?: string): Promise<string>;
  env: Record<string, string | undefined>;
}

export async function setup(env: Record<string, string | undefined> = {}): Promise<Env> {
  const base = await mkTmp();
  const home = path.join(base, 'home');
  const root = path.join(home, '.agent-tools');
  const registry = path.join(root, 'mcp-registry');
  await fs.mkdir(registry, { recursive: true });
  const events: AtmEvent[] = [];
  const atm = createAtm({ home, env, onEvent: (e) => events.push(e) });
  return {
    base,
    home,
    root,
    registry,
    events,
    atm,
    env,
    async project(name = 'proj') {
      const dir = path.join(base, 'work', name);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
  };
}

export async function readJson<T = Record<string, any>>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** 目录树快照（路径 → 内容 / 软链目标），用来断言「没碰磁盘」。 */
export async function treeSnapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isSymbolicLink()) out[rel] = '-> ' + (await fs.readlink(full));
      else if (e.isDirectory()) {
        out[rel + '/'] = '';
        await walk(full);
      } else out[rel] = await fs.readFile(full, 'utf8');
    }
  }
  await walk(dir);
  return out;
}

export async function writeInstalledPlugins(home: string, plugins: Record<string, { files?: Record<string, string>; version?: string }>): Promise<void> {
  const installed: Record<string, unknown[]> = {};
  for (const [name, p] of Object.entries(plugins)) {
    const installPath = path.join(home, '.claude', 'plugins', 'cache', name.replace('@', '_'));
    await fs.mkdir(installPath, { recursive: true });
    await writeFiles(installPath, p.files ?? {});
    installed[name] = [{ scope: 'user', installPath, version: p.version ?? '1.0.0' }];
  }
  await write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }, null, 2));
}
