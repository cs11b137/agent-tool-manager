/**
 * 代码评审修复的回归测试（每个 describe 对应一条 finding）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AtmError, estimateTokens, validateLock, validateManifest, validateMcpDef } from '../src/index.js';
import { atomicWrite, applyOps, type Op } from '../src/fs/atomic.js';
import { git as coreGit } from '../src/git.js';
import { resolveWorktree } from '../src/manifest.js';
import { listToolsStdio } from '../src/mcp/measure.js';
import { isPlaintextSecret, isSafeSecretValue, looksLikeSecret, scanServer } from '../src/mcp/secrets.js';
import { parseRepo } from '../src/skills/repo.js';
import { exists, git, makeRemote, readJson, setup, skillMd, write, writeInstalledPlugins } from './helpers.js';

const FAKE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs');

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as AtmError).code ?? 'ERROR';
  }
}

const op = (action: Op['action'], p: string, extra: Partial<Op['change']> = {}, more: Partial<Op> = {}): Op => ({
  action,
  change: { path: p, relPath: path.basename(p), type: 'file', before: null, after: null, diff: '', additions: 0, deletions: 0, ...extra },
  ...more,
});

describe('#1 lock worktree is relative to <root>', () => {
  it('pin stores .worktrees/<repo>@<rev>; values outside <root> are rejected', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'skills', { 'x/SKILL.md': skillMd('x', 'v1') });
    git(remote.work, 'tag', 'v1');
    git(remote.work, 'push', '-q', 'origin', 'v1');
    const dir = await env.project();
    await env.atm.init(dir);
    await env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'x' });
    await env.atm.pin(dir, 'x', 'v1');
    const lockPath = path.join(dir, '.agents/tools.lock.json');
    const lock = await readJson(lockPath);
    expect(lock.skills.x.worktree).toBe(path.join('.worktrees', 'skills@v1'));

    // 旧版 lock 写的是 <root> 内的绝对路径：仍可用，install 时改写成相对形式
    lock.skills.x.worktree = path.join(env.root, '.worktrees', 'skills@v1');
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
    await env.atm.install(dir);
    expect((await readJson(lockPath)).skills.x.worktree).toBe(path.join('.worktrees', 'skills@v1'));

    // 解析到 <root> 之外：validateLock（`..` 逃逸）或使用时（绝对路径）拒绝
    expect(codeOf(() => validateLock({ version: 1, skills: { x: { repo: 'a/b', path: 'x', worktree: '../../etc' } } }))).toBe('INVALID_MANIFEST');
    expect(() => resolveWorktree(env.root, '/etc')).toThrow(AtmError);
    expect(() => resolveWorktree(env.root, '.worktrees/../../x')).toThrow(AtmError);
    expect(resolveWorktree(env.root, '.worktrees/a@b')).toBe(path.join(env.root, '.worktrees', 'a@b'));

    const evil = await readJson(lockPath);
    evil.skills.x.worktree = path.join(env.base, 'elsewhere');
    await fs.writeFile(lockPath, JSON.stringify(evil, null, 2));
    await expect(env.atm.install(dir)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    const issue = (await env.atm.doctor(dir)).issues.find((i) => i.name === 'x' && (i.code === 'broken-link' || i.code === 'missing-link'));
    expect(issue).toMatchObject({ fixable: false });
    expect(issue!.detail).toContain('outside');
  });
});

describe('#2 init keeps migrated real skill directories tracked', () => {
  it('does not blanket-ignore .agents/skills/ when real dirs were migrated; ignores atm symlinks per name', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'kit', { 'y/SKILL.md': skillMd('y', 'from repo') });
    const dir = await env.project();
    git(dir, 'init', '-q');
    await write(path.join(dir, '.claude/skills/local-skill/SKILL.md'), skillMd('local-skill', 'committed'));
    const res = await env.atm.init(dir);
    expect(res.warnings.join('\n')).toMatch(/NOT gitignored/);
    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi.split('\n')).not.toContain('.agents/skills/');
    expect(gi.split('\n')).toContain('.claude/skills');

    await env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'y' });
    expect((await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).split('\n')).toContain('.agents/skills/y');
    const ignored = (p: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', p], { cwd: dir });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('.agents/skills/local-skill/SKILL.md')).toBe(false);
    expect(ignored('.agents/skills/y')).toBe(true);
    expect(ignored('.claude/skills')).toBe(true);
  });

  it('keeps the blanket ignore when nothing real was migrated', async () => {
    const env = await setup();
    const dir = await env.project();
    await env.atm.init(dir);
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toContain('.agents/skills/\n.claude/skills\n');
  });
});

describe('#3 atomicWrite follows symlinks and preserves mode', () => {
  it('writes through a symlinked config file and keeps permissions', async () => {
    const env = await setup();
    const real = path.join(env.base, 'dotfiles', 'mcp.json');
    await write(real, '{}\n');
    await fs.chmod(real, 0o600);
    const link = path.join(env.base, 'proj', '.mcp.json');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(real, link);
    await atomicWrite(link, '{"a":1}\n');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, 'utf8')).toBe('{"a":1}\n');
    expect((await fs.stat(real)).mode & 0o777).toBe(0o600);

    // 普通文件同样保留权限
    const plain = path.join(env.base, 'plain.sh');
    await write(plain, 'x');
    await fs.chmod(plain, 0o755);
    await atomicWrite(plain, 'y');
    expect((await fs.stat(plain)).mode & 0o777).toBe(0o755);
  });
});

describe('#4 parseRepo is strict', () => {
  it('rejects relative paths, dot segments and leading dashes', () => {
    for (const bad of ['./x', '../x', 'x', 'a/..', '../..', '.hidden/x', 'a/.b', '-x/y', 'owner/-y', '-oops', 'https://h.com/a/../b', 'ftp://h.com/a/b', 'git@-h:a/b', '-u@h:a/b', 'file://rel/x', 'https://h.com/./b']) {
      expect(codeOf(() => parseRepo(bad, '/h')), bad).toBe('NOT_FOUND');
    }
    expect(parseRepo('ssh://git@h.com/a/b.git', '/h')).toMatchObject({ name: 'b', owner: 'a' });
    expect(parseRepo('~/src/kit.git', '/h')).toMatchObject({ url: '/h/src/kit.git', name: 'kit' });
  });
});

describe('#5 a repo dir occupied by another remote is never used', () => {
  it('list/doctor report the link as unusable and sync skips the repo', async () => {
    const env = await setup();
    const a = await makeRemote(env.base, 'skills', { 'x/SKILL.md': skillMd('x', 'from A') });
    const b = await makeRemote(env.base, 'other/skills', { 'x/SKILL.md': skillMd('x', 'from B') });
    const dir = await env.project();
    await env.atm.init(dir);
    await env.atm.add(dir, { kind: 'skill', repo: a.bare, name: 'x' });
    // 有人把 <root>/skills 换成了另一个仓库
    const repoDir = path.join(env.root, 'skills');
    await fs.rm(repoDir, { recursive: true });
    git(env.root, 'clone', '-q', b.bare, 'skills');
    const bHead = git(repoDir, 'rev-parse', 'HEAD');
    await b.commit({ 'x/SKILL.md': skillMd('x', 'B moved on') });

    const detail = await env.atm.list(dir);
    const skill = detail.tools[0]!;
    expect(skill.skill).toMatchObject({ linked: true, broken: true });
    expect(skill.skill!.description).toBeUndefined(); // 没读 B 的内容
    const issue = detail.issues.find((i) => i.name === 'x' && i.code === 'broken-link')!;
    expect(issue).toMatchObject({ level: 'error', fixable: false });
    expect(issue.detail).toContain('another repository');

    const res = await env.atm.sync();
    expect(res.repos).toEqual([expect.objectContaining({ repo: a.bare, status: 'failed', message: expect.stringContaining('another repository') })]);
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(bHead); // B 没被 pull
    expect(res.updatedProjects).toEqual([]);
  });
});

describe('#7 secret scanning', () => {
  it('requires exactly one reference (optionally with a short prefix)', () => {
    expect(isPlaintextSecret('API_KEY', 'hunter2$Secret')).toBe(true);
    expect(isPlaintextSecret('Authorization', 'Bearer sk-live ${X}')).toBe(true);
    expect(isPlaintextSecret('API_KEY', '${A}${B}')).toBe(true);
    expect(isPlaintextSecret('API_KEY', 'x${API_KEY}')).toBe(true);
    expect(isPlaintextSecret('Authorization', 'Bearer ${X}')).toBe(false);
    expect(isPlaintextSecret('Authorization', 'Basic ${env:CRED}')).toBe(false);
    expect(isPlaintextSecret('Authorization', 'token $GH_TOKEN')).toBe(false);
    expect(isSafeSecretValue('Bearer  ${X}')).toBe(false);
    const code = (headers: Record<string, string>) => codeOf(() => validateMcpDef({ name: 'a', transport: 'http', url: 'https://x.dev', headers }));
    expect(code({ Authorization: 'Bearer sk-live ${X}' })).toBe('INVALID_MCP_DEF');
    expect(code({ Authorization: 'hunter2${X}' })).toBe('INVALID_MCP_DEF');
    expect(code({ Authorization: 'Bearer ${X}' })).toBeNull();
  });

  it('flags secret-looking args/url as warn-level', () => {
    expect(looksLikeSecret('--api-key=sk-abcdefgh12345678')).toBe(true);
    expect(looksLikeSecret('ghp_0123456789abcdefABCDEF')).toBe(true);
    expect(looksLikeSecret('xoxb-1234-abcdefgh')).toBe(true);
    expect(looksLikeSecret('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(looksLikeSecret('https://x.dev/mcp?key=aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI')).toBe(true);
    expect(looksLikeSecret('@modelcontextprotocol/server-filesystem-with-a-long-name')).toBe(false);
    expect(looksLikeSecret('${FIGMA_API_KEY}')).toBe(false);
    expect(looksLikeSecret('-y')).toBe(false);
    expect(scanServer('s', { command: 'x', args: ['--token', 'sk-abcdefgh12345678'] })).toEqual([{ server: 's', field: 'args', key: '1', level: 'warn' }]);
  });

  it('doctor: unparseable agent config → config-unparseable error; secret in args → warn', async () => {
    const env = await setup();
    const dir = await env.project();
    await env.atm.init(dir);
    await write(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp', args: ['--token', 'ghp_0123456789abcdefABCDEF'] } } }));
    await write(path.join(dir, '.cursor/mcp.json'), '{ not json');
    const r = await env.atm.doctor(dir);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'config-unparseable', level: 'error', name: '.cursor/mcp.json', fixable: false }));
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'plaintext-secret', level: 'warn', name: 'gh@.mcp.json' }));
  });
});

describe('#8 names are validated before being used in paths', () => {
  it('manifest, lock and add reject unsafe skill / mcp / plugin names', async () => {
    const m = (raw: unknown) => codeOf(() => validateManifest(raw));
    expect(m({ agents: [], skills: [{ repo: 'a/b', name: '../evil' }] })).toBe('INVALID_MANIFEST');
    expect(m({ agents: [], skills: [{ repo: 'a/b', name: '..' }] })).toBe('INVALID_MANIFEST');
    expect(m({ agents: [], skills: [{ repo: 'a/b', name: '.' }] })).toBe('INVALID_MANIFEST');
    expect(m({ agents: [], skills: [{ repo: 'a/b', name: 'a/b' }] })).toBe('INVALID_MANIFEST');
    expect(m({ agents: [], mcp: ['../x'] })).toBe('INVALID_MANIFEST');
    expect(m({ agents: [], mcp: [{ name: '.hidden' }] })).toBe('INVALID_MANIFEST');
    expect(m({ agents: [], plugins: ['no-marketplace'] })).toBe('INVALID_MANIFEST');
    expect(m({ agents: [], plugins: ['a@../b'] })).toBe('INVALID_MANIFEST');
    expect(m({ agents: [], skills: [{ repo: 'a/b', name: 'ok.name_1-x' }], mcp: ['figma'], plugins: ['p@m'] })).toBeNull();
    const l = (raw: unknown) => codeOf(() => validateLock(raw));
    expect(l({ version: 1, skills: { '..': { repo: 'a/b', path: 'x' } } })).toBe('INVALID_MANIFEST');
    expect(l({ version: 1, mcp: { 'a/b': { hash: 'sha256:x' } } })).toBe('INVALID_MANIFEST');

    const env = await setup();
    const remote = await makeRemote(env.base, 'kit', { 'skills/comic/SKILL.md': skillMd('Baoyu Comic', 'x') });
    const dir = await env.project();
    await env.atm.init(dir);
    await expect(env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: '../../escape' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'Baoyu Comic' })).rejects.toMatchObject({ code: 'NOT_FOUND', candidates: ['comic'] });
    expect(await exists(path.join(env.base, 'escape'))).toBe(false);
    expect((await readJson(path.join(dir, '.agents/tools.json'))).skills).toEqual([]);
  });
});

describe('#9 rollback', () => {
  it('undoing mkdir is non-recursive and keeps foreign content', async () => {
    const env = await setup();
    const top = path.join(env.base, 'x');
    const foreign = path.join(top, 'foreign.txt');
    const ops: Op[] = [
      op('mkdir', path.join(top, 'y'), { type: 'dir' }),
      // 规划之外（例如另一个进程）在 x/ 下放了文件
      op('exec', top, { type: 'dir' }, { exec: () => fs.writeFile(foreign, 'keep me') }),
      op('exec', top, { type: 'dir' }, { exec: () => Promise.reject(new Error('injected')) }),
    ];
    await expect(applyOps(ops)).rejects.toThrow('injected');
    expect(await exists(path.join(top, 'y'))).toBe(false);
    expect(await fs.readFile(foreign, 'utf8')).toBe('keep me');
  });

  it('rollback failures are surfaced in the thrown error', async () => {
    const env = await setup();
    const ops: Op[] = [
      op('exec', env.base, {}, { exec: async () => undefined, undo: () => Promise.reject(new Error('undo-boom')) }),
      op('exec', env.base, {}, { exec: () => Promise.reject(new Error('apply-failed')) }),
    ];
    const err = (await applyOps(ops).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('apply-failed');
    expect(err.message).toContain('rollback incomplete');
    expect(err.message).toContain('undo-boom');
  });
});

describe('#10 sync re-points symlinks when upstream moves a skill', () => {
  it('updates lock.path and the .agents/skills symlink together', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'kit', { 'skills/one/SKILL.md': skillMd('one', 'first') });
    const dir = await env.project();
    await env.atm.init(dir);
    await env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'one' });
    git(remote.work, 'mv', 'skills/one', 'skills/moved-one');
    git(remote.work, 'commit', '-q', '-m', 'move');
    git(remote.work, 'push', '-q', 'origin', 'main');

    env.events.length = 0;
    const res = await env.atm.sync();
    expect(res.updatedProjects).toEqual([env.atm.projectId(dir)]);
    const lock = await readJson(path.join(dir, '.agents/tools.lock.json'));
    expect(lock.skills.one.path).toBe(path.join('skills', 'moved-one'));
    const link = path.join(dir, '.agents/skills/one');
    expect(await fs.readlink(link)).toBe(path.join(env.root, 'kit', 'skills', 'moved-one'));
    expect(await fs.readFile(path.join(link, 'SKILL.md'), 'utf8')).toContain('first');
    expect((await env.atm.doctor(dir)).issues.filter((i) => i.code === 'broken-link')).toEqual([]);
  });
});

describe('#11 doctor fixable flags and fix robustness', () => {
  it('real dirs → skill-dir-conflict (not fixable); working link elsewhere is not fixable; fix continues past failures', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'kit', { 'a/SKILL.md': skillMd('a', 'a'), 'b/SKILL.md': skillMd('b', 'b') });
    const p1 = await env.project('p1');
    const p2 = await env.project('p2');
    for (const d of [p1, p2]) {
      await env.atm.init(d);
      await env.atm.add(d, { kind: 'skill', repo: remote.bare, name: 'a' });
      await env.atm.add(d, { kind: 'skill', repo: remote.bare, name: 'b' });
      await fs.rm(path.join(d, '.agents/skills/a')); // 缺链：可修复
    }
    // p1：b 位置是实体目录；.claude/skills 指向别处的有效目录 → fix 会 CONFLICT
    await fs.rm(path.join(p1, '.agents/skills/b'));
    await write(path.join(p1, '.agents/skills/b/SKILL.md'), 'real');
    const elsewhere = path.join(env.base, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.rm(path.join(p1, '.claude/skills'));
    await fs.symlink(elsewhere, path.join(p1, '.claude/skills'));

    const r = await env.atm.doctor('all');
    const of = (pid: string, name: string) => r.issues.filter((i) => i.projectId === pid && i.name === name);
    const id1 = env.atm.projectId(p1);
    const id2 = env.atm.projectId(p2);
    expect(of(id1, 'b')).toEqual([expect.objectContaining({ code: 'skill-dir-conflict', level: 'error', fixable: false })]);
    expect(of(id1, '.claude/skills')).toEqual([expect.objectContaining({ code: 'broken-link', fixable: false, nextCommand: 'atm install --force' })]);
    expect(of(id1, 'a')).toEqual([expect.objectContaining({ code: 'missing-link', fixable: true })]);
    expect(of(id2, 'a')).toEqual([expect.objectContaining({ code: 'missing-link', fixable: true })]);

    const fixed = await env.atm.fix([of(id1, 'a')[0]!.id, of(id2, 'a')[0]!.id]);
    expect(fixed.applied).toBe(true);
    // p1 的修复失败（实体目录 → CONFLICT）只记进 warnings，p2 照常修复
    expect(fixed.warnings.some((w) => w.startsWith('fix p1 failed') && w.includes('real directory'))).toBe(true);
    expect(await fs.readlink(path.join(p2, '.agents/skills/a'))).toBe(path.join(env.root, 'kit', 'a'));
    // p1 的实体目录没被碰
    expect(await fs.readFile(path.join(p1, '.agents/skills/b/SKILL.md'), 'utf8')).toBe('real');
  });

  it('a real .claude/skills directory is reported as skill-dir-conflict; a broken entry link is fixable', async () => {
    const env = await setup();
    const p = await env.project();
    await env.atm.init(p);
    await fs.rm(path.join(p, '.claude/skills'));
    await write(path.join(p, '.claude/skills/hand/SKILL.md'), 'x');
    let r = await env.atm.doctor(p);
    expect(r.issues.find((i) => i.name === '.claude/skills')).toMatchObject({ code: 'skill-dir-conflict', fixable: false, nextCommand: 'atm init' });
    await fs.rm(path.join(p, '.claude/skills'), { recursive: true });
    await fs.symlink(path.join(env.base, 'gone'), path.join(p, '.claude/skills'));
    r = await env.atm.doctor(p);
    const broken = r.issues.find((i) => i.name === '.claude/skills')!;
    expect(broken).toMatchObject({ code: 'broken-link', fixable: true });
    await env.atm.fix([broken.id]);
    expect(await fs.readlink(path.join(p, '.claude/skills'))).toBe(path.join('..', '.agents', 'skills'));
  });
});

describe('#12 stdio measure', () => {
  it('decodes UTF-8 split across chunks', async () => {
    const tools = (await listToolsStdio({ name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_SERVER] }, { FAKE_MODE: 'split' })) as Array<{ description: string }>;
    expect(tools.map((t) => t.description)).toEqual(['Echo the input back', '两个数相加 𠀀']);
  });

  it('kills the whole process group on timeout', async () => {
    const env = await setup();
    const pidFile = path.join(env.base, 'grandchild.pid');
    await expect(
      listToolsStdio({ name: 'hang', transport: 'stdio', command: process.execPath, args: [FAKE_SERVER] }, { FAKE_MODE: 'hang', FAKE_PID_FILE: pidFile }, undefined, 800),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('timed out') });
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  });
});

describe('#13 plugin context and CJK Extension B', () => {
  it('plugin tokens include measured bundled MCP; unmeasured bundled MCP counts toward unmeasured', async () => {
    const env = await setup();
    await writeInstalledPlugins(env.home, {
      'p@m': { files: { 'skills/s/SKILL.md': skillMd('s', 'plugin skill'), '.mcp.json': JSON.stringify({ mcpServers: { pmcp: { command: 'x' } } }) } },
    });
    const dir = await env.project();
    await env.atm.init(dir);
    const added = await env.atm.add(dir, { kind: 'plugin', name: 'p@m' });
    expect(added.contextAfter?.unmeasured).toBe(1);
    let detail = await env.atm.list(dir);
    const skillOnly = detail.tools[0]!.contextTokens!;
    expect(skillOnly).toBeGreaterThan(0);
    expect(detail.context.unmeasured).toBe(1);
    expect(detail.issues.find((i) => i.code === 'context-total')!.title).toContain('+1 unmeasured');

    const lockPath = path.join(dir, '.agents/tools.lock.json');
    const lock = await readJson(lockPath);
    lock.mcp.pmcp = { hash: 'sha256:x', contextTokens: 50 };
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
    detail = await env.atm.list(dir);
    expect(detail.tools[0]!.contextTokens).toBe(skillOnly + 50);
    expect(detail.context).toMatchObject({ plugin: skillOnly + 50, unmeasured: 0 });
  });

  it('counts CJK Extension B characters as CJK', () => {
    expect(estimateTokens('𠀀𠀁𠀂')).toBe(2); // 3 / 1.5
    expect(estimateTokens('𪚥')).toBe(1);
  });
});

describe('#14 git clone argument safety', () => {
  it('passes -- before the URL and refuses specs starting with -', async () => {
    const env = await setup();
    const marker = path.join(env.base, 'pwned');
    await expect(coreGit.clone(`--upload-pack=touch ${marker}`, path.join(env.base, 'c1'))).rejects.toBeInstanceOf(AtmError);
    expect(await exists(marker)).toBe(false);
    const err = (await coreGit.clone(path.join(env.base, 'no-such-repo'), path.join(env.base, 'c2')).catch((e: unknown) => e)) as AtmError;
    expect(err.code).toBe('GIT_FAILED');
    expect(err.message).toContain(`clone --quiet -- ${path.join(env.base, 'no-such-repo')}`);
  });
});
