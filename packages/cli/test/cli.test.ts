import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, '..', 'src', 'bin.ts');
// absolute loader URL: children run with cwd in a temp dir where `tsx` would not resolve
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'atm-test',
  GIT_AUTHOR_EMAIL: 'atm@test.local',
  GIT_COMMITTER_NAME: 'atm-test',
  GIT_COMMITTER_EMAIL: 'atm@test.local',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function writeFiles(base: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
    await fs.writeFile(path.join(base, rel), content);
  }
}

interface Fixture {
  base: string;
  home: string;
  root: string;
  dir: string;
  bare: string;
  run(args: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

async function fixture(): Promise<Fixture> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atm-cli-')));
  temps.push(base);
  const home = path.join(base, 'home');
  const root = path.join(home, '.agent-tools');
  await fs.mkdir(path.join(root, 'mcp-registry'), { recursive: true });
  const dir = path.join(base, 'work', 'proj');
  await fs.mkdir(dir, { recursive: true });

  // local bare repo with two skills
  const bare = path.join(base, 'remotes', 'demo-skills.git');
  const work = path.join(base, 'remotes-work', 'demo-skills');
  await fs.mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  await fs.mkdir(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', bare);
  await writeFiles(work, {
    'skills/comic/SKILL.md': '---\nname: demo-comic\ndescription: Turn a story into a comic strip\n---\n# comic\n',
    'skills/cover/SKILL.md': '---\nname: demo-cover\ndescription: Generate a cover image\n---\n# cover\n',
  });
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', 'origin', 'main');

  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV, HOME: home };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;

  const run: Fixture['run'] = (args, opts = {}) =>
    new Promise((resolve) => {
      execFile(process.execPath, ['--import', TSX, BIN, ...args], { cwd: opts.cwd ?? dir, env, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      });
    });

  return { base, home, root, dir, bare, run };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
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

const ANSI = /\x1b\[/;

describe('atm cli', () => {
  it('init → add skill → list --json → remove → doctor --json', async () => {
    const f = await fixture();

    const init = await f.run(['init', '--json']);
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ applied: true, warnings: [] });
    expect(await fs.readlink(path.join(f.dir, '.claude/skills'))).toBe(path.join('..', '.agents', 'skills'));

    // text mode: file list, no ANSI when stdout is not a TTY
    const add = await f.run(['add', 'skill', f.bare, 'demo-cover']);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain('✔ skill demo-cover');
    expect(add.stdout).toContain('.agents/tools.json');
    expect(add.stdout).toMatch(/\+\d+ -\d+/);
    expect(add.stdout).not.toMatch(ANSI);
    expect(await fs.readlink(path.join(f.dir, '.agents/skills/demo-cover'))).toBe(path.join(f.root, 'demo-skills', 'skills/cover'));

    const list = await f.run(['list', '--json']);
    expect(list.code).toBe(0);
    const detail = JSON.parse(list.stdout);
    expect(detail).toMatchObject({
      name: 'proj',
      path: f.dir,
      initialized: true,
      agents: ['claude-code'],
      counts: { skills: 1, mcp: 0, plugins: 0 },
      context: { total: expect.any(Number) },
      tools: [{ kind: 'skill', name: 'demo-cover', agents: ['claude-code'], skill: { linked: true, broken: false, path: 'skills/cover' } }],
      issues: expect.any(Array),
    });
    expect(detail.id).toMatch(/^[0-9a-f]{12}$/);

    // --cwd targets another dir; text list shows the table and context total
    const text = await f.run(['list', '--cwd', f.dir], { cwd: f.base });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Skills (1)');
    expect(text.stdout).toMatch(/demo-cover\s+\S+demo-skills\.git\s+[0-9a-f]{7}/);
    expect(text.stdout).toMatch(/context ≈ \d+ tokens/);

    const rm = await f.run(['remove', 'demo-cover', '--json']);
    expect(rm.code).toBe(0);
    expect(JSON.parse(rm.stdout).applied).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(f.dir, '.agents/tools.json'), 'utf8')).skills).toEqual([]);

    const doctor = await f.run(['doctor', '--json']);
    expect(doctor.code).toBe(0);
    const report = JSON.parse(doctor.stdout);
    expect(report).toMatchObject({ measured: false, counts: { error: 0 }, projects: [{ name: 'proj' }] });
    expect(report.issues.some((i: { code: string }) => i.code === 'context-total')).toBe(true);

    const doctorText = await f.run(['doctor']);
    expect(doctorText.code).toBe(0);
    expect(doctorText.stdout).toContain('Info');
    expect(doctorText.stdout).toMatch(/ℹ Context ≈ \d+ tokens/);
  });

  it('doctor exits 1 when there is an error-level issue', async () => {
    const f = await fixture();
    expect((await f.run(['init'])).code).toBe(0);
    expect((await f.run(['add', 'skill', f.bare, 'demo-comic'])).code).toBe(0);
    await fs.rm(path.join(f.root, 'demo-skills'), { recursive: true, force: true });

    const json = await f.run(['doctor', '--json']);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout);
    expect(report.counts.error).toBeGreaterThan(0);
    expect(report.issues.find((i: { level: string }) => i.level === 'error')).toMatchObject({ name: 'demo-comic', nextCommand: expect.any(String) });

    const text = await f.run(['doctor']);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('Errors');
    expect(text.stdout).toContain('→ ');
  });

  it('--dry-run writes nothing and prints a diff', async () => {
    const f = await fixture();
    expect((await f.run(['init'])).code).toBe(0);
    const before = await snapshot(f.base);

    const json = await f.run(['add', 'skill', f.bare, 'demo-comic', '--dry-run', '--json']);
    expect(json.code).toBe(0);
    const r = JSON.parse(json.stdout);
    expect(r.applied).toBe(false);
    expect(r.files.map((x: { relPath: string }) => x.relPath)).toContain('.agents/tools.json');

    const text = await f.run(['add', 'skill', f.bare, 'demo-comic', '--dry-run']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('dry run');
    expect(text.stdout).toContain('+++ b/.agents/tools.json');
    expect(text.stdout).toMatch(/^\+\s+"name": "demo-comic"/m);

    expect(await snapshot(f.base)).toEqual(before);
  });

  it('--json errors print AtmErrorJson to stdout with exit 1', async () => {
    const f = await fixture();
    const r = await f.run(['list', '--json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ error: { code: 'NOT_INITIALIZED', message: expect.any(String), nextCommand: 'atm init' } });

    expect((await f.run(['init'])).code).toBe(0);
    const nf = await f.run(['add', 'skill', f.bare, 'nope', '--json']);
    expect(nf.code).toBe(1);
    expect(JSON.parse(nf.stdout).error).toMatchObject({ code: 'NOT_FOUND', nextCommand: expect.any(String) });

    // text mode: message + next command on stderr, nothing on stdout
    const t = await f.run(['remove', 'nope']);
    expect(t.code).toBe(1);
    expect(t.stdout).toBe('');
    expect(t.stderr).toMatch(/^✖ /);
    expect(t.stderr).toContain('→ atm list');
  });

  it('exits 2 with usage on bad usage', async () => {
    const f = await fixture();
    for (const args of [[], ['bogus'], ['add'], ['add', 'thing', 'x'], ['add', 'skill', 'only-repo'], ['list', '--nope'], ['remove', 'x', '--kind', 'tool'], ['add', 'mcp', 'x', '--agents', 'vim'], ['pin', 'x']]) {
      const r = await f.run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stdout, args.join(' ')).toBe('');
      expect(r.stderr, args.join(' ')).toContain('Usage:');
    }
  });

  it('prints help and version', async () => {
    const f = await fixture();
    const help = await f.run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('add skill');
    const sub = await f.run(['add', 'mcp', '-h']);
    expect(sub.code).toBe(0);
    expect(sub.stdout).toContain('atm add mcp <name>');
    const v = await f.run(['--version']);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
