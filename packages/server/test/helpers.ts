import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const temps: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const t of temps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

export async function mkTmp(prefix = 'atm-server-test-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

export async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

/** Local bare repo + work clone with the given files pushed to `main`. */
export async function makeRemote(base: string, name: string, files: Record<string, string>): Promise<{ bare: string; work: string }> {
  const bare = path.join(base, 'remotes', `${name}.git`);
  const work = path.join(base, 'remotes-work', name);
  await fs.mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  await fs.mkdir(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', bare);
  for (const [rel, content] of Object.entries(files)) await write(path.join(work, rel), content);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  return { bare, work };
}

export interface Fixture {
  base: string;
  home: string;
  root: string;
  env: Record<string, string | undefined>;
  project(name?: string): Promise<string>;
}

export async function fixture(): Promise<Fixture> {
  const base = await mkTmp();
  const home = path.join(base, 'home');
  const root = path.join(home, '.agent-tools');
  await fs.mkdir(path.join(root, 'mcp-registry'), { recursive: true });
  return {
    base,
    home,
    root,
    env: {},
    async project(name = 'proj') {
      const dir = path.join(base, 'work', name);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
  };
}

/** Directory tree snapshot (path → content / symlink target) to assert "nothing was written". */
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

export async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000, intervalMs = 50): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
