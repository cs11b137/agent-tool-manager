import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AtmError, type AtmEvent } from '../src/index.js';
import { acquireLock } from '../src/fs/lock.js';
import { applyOps, type Op } from '../src/fs/atomic.js';
import { createCtx } from '../src/context.js';
import { executeWrite } from '../src/ops/write.js';
import { exists, git, makeRemote, readJson, setup, skillMd, write, writeInstalledPlugins } from './helpers.js';

const FAKE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs');

describe('file lock', () => {
  it('second writer gets LOCKED; stale locks are taken over', async () => {
    const env = await setup();
    const dir = await env.project();
    await env.atm.init(dir);
    const lockPath = path.join(dir, '.agents/.lock');
    const held = await acquireLock(lockPath);
    await expect(acquireLock(lockPath)).rejects.toMatchObject({ code: 'LOCKED' });
    const addErr = await env.atm.add(dir, { kind: 'plugin', name: 'x@y' }, {}).catch((e: unknown) => e);
    expect(addErr).toBeInstanceOf(AtmError);
    expect(addErr).toMatchObject({ code: 'LOCKED' });
    const err = await env.atm.install(dir).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'LOCKED' });
    // dryRun 不需要锁
    expect((await env.atm.install(dir, { dryRun: true })).applied).toBe(false);
    await held.release();
    expect(await exists(lockPath)).toBe(false);

    await fs.writeFile(lockPath, '999999 old');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);
    const taken = await acquireLock(lockPath);
    await taken.release();
  });

  it('concurrent stale-lock takeover: exactly one of two takers wins', async () => {
    const env = await setup();
    const lockPath = path.join(env.base, '.agents/.lock');
    for (let round = 0; round < 10; round++) {
      await write(lockPath, '999999 dead-token old');
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, old, old);
      const results = await Promise.allSettled([acquireLock(lockPath), acquireLock(lockPath)]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'LOCKED' });
      await (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>>).value.release();
      expect(await exists(lockPath)).toBe(false);
    }
  });

  it('release() does not delete a lock that was taken over by someone else', async () => {
    const env = await setup();
    const lockPath = path.join(env.base, '.agents/.lock');
    const first = await acquireLock(lockPath);
    // first 卡住超过 30s：second 视为过期并接管
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);
    const second = await acquireLock(lockPath);
    await first.release();
    expect(await exists(lockPath)).toBe(true);
    await expect(acquireLock(lockPath)).rejects.toMatchObject({ code: 'LOCKED' });
    await second.release();
    expect(await exists(lockPath)).toBe(false);
  });
});

describe('atomic apply', () => {
  it('rolls back already-applied ops when a later op fails', async () => {
    const env = await setup();
    const a = path.join(env.base, 'a.txt');
    await fs.writeFile(a, 'old');
    const ops: Op[] = [
      { action: 'write', change: { path: a, relPath: 'a.txt', type: 'file', before: 'old', after: 'new', diff: '', additions: 0, deletions: 0 } },
      { action: 'write', change: { path: path.join(env.base, 'b.txt'), relPath: 'b.txt', type: 'file', before: null, after: 'b', diff: '', additions: 0, deletions: 0 } },
      { action: 'move', from: path.join(env.base, 'does-not-exist'), change: { path: path.join(env.base, 'c'), relPath: 'c', type: 'dir', before: null, after: null, diff: '', additions: 0, deletions: 0 } },
    ];
    await expect(applyOps(ops)).rejects.toThrow();
    expect(await fs.readFile(a, 'utf8')).toBe('old');
    expect(await exists(path.join(env.base, 'b.txt'))).toBe(false);
  });

  it('executeWrite: a failure mid-apply leaves manifest/lock byte-identical and undoes symlink/unlink/mkdir', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'kit', { 'x/SKILL.md': skillMd('x', 'x') });
    const dir = await env.project();
    await env.atm.init(dir);
    await env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'x' });
    const manifestPath = path.join(dir, '.agents/tools.json');
    const lockPath = path.join(dir, '.agents/tools.lock.json');
    const manifestBefore = await fs.readFile(manifestPath, 'utf8');
    const lockBefore = await fs.readFile(lockPath, 'utf8');
    const skills = path.join(dir, '.agents/skills');
    await fs.symlink('/old/target', path.join(skills, 'repoint'));
    await fs.symlink('/gone/target', path.join(skills, 'gone'));
    const xTarget = await fs.readlink(path.join(skills, 'x'));

    const ctx = createCtx({ home: env.home });
    const err = await executeWrite(ctx, {
      dir,
      command: 'test',
      activity: { message: 'test' },
      async plan({ planner }) {
        planner.mkdir(path.join(dir, 'newdir', 'sub'));
        planner.symlink(path.join(skills, 'fresh'), null, '/fresh/target');
        planner.symlink(path.join(skills, 'repoint'), '/old/target', '/new/target');
        planner.unlink(path.join(skills, 'gone'), '/gone/target');
        planner.unlink(path.join(skills, 'x'), xTarget);
        planner.write(manifestPath, manifestBefore, manifestBefore.replace('"skills"', '"skills" ').concat('\n'));
        planner.write(lockPath, lockBefore, '{"broken": true}\n');
        planner.exec(dir, 'injected failure', () => Promise.reject(new Error('injected failure')));
      },
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: expect.stringContaining('injected failure') });
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(await fs.readFile(lockPath, 'utf8')).toBe(lockBefore);
    expect(await exists(path.join(dir, 'newdir'))).toBe(false);
    expect(await exists(path.join(skills, 'fresh'))).toBe(false);
    expect(await fs.readlink(path.join(skills, 'repoint'))).toBe('/old/target');
    expect(await fs.readlink(path.join(skills, 'gone'))).toBe('/gone/target');
    expect(await fs.readlink(path.join(skills, 'x'))).toBe(xTarget);
    expect(await exists(path.join(dir, '.agents/.lock'))).toBe(false);
  });
});

describe('sync', () => {
  it('fast-forwards a clean clone and updates locks; skips a dirty clone', async () => {
    const env = await setup();
    const { atm } = env;
    const r1 = await makeRemote(env.base, 'clean', { 'skills/one/SKILL.md': skillMd('one', 'first') });
    const r2 = await makeRemote(env.base, 'dirty', { 'two/SKILL.md': skillMd('two', 'second') });
    const dir = await env.project();
    await atm.init(dir);
    await atm.add(dir, { kind: 'skill', repo: r1.bare, name: 'one' });
    await atm.add(dir, { kind: 'skill', repo: r2.bare, name: 'two' });
    const oldCommit = (await readJson(path.join(dir, '.agents/tools.lock.json'))).skills.one.commit;

    const newCommit = await r1.commit({ 'skills/one/SKILL.md': skillMd('one', 'first, now with a much longer description') });
    await r2.commit({ 'two/README.md': 'x' });
    await fs.writeFile(path.join(env.root, 'dirty', 'local.txt'), 'uncommitted');

    const dry = await atm.sync(undefined, { dryRun: true });
    expect(dry.repos.find((r) => r.dir.endsWith('clean'))).toMatchObject({ status: 'updated', to: newCommit });
    expect(git(path.join(env.root, 'clean'), 'rev-parse', 'HEAD')).toBe(oldCommit);

    env.events.length = 0;
    const res = await atm.sync();
    const clean = res.repos.find((r) => r.dir.endsWith('clean'))!;
    const dirty = res.repos.find((r) => r.dir.endsWith('dirty'))!;
    expect(clean).toMatchObject({ status: 'updated', from: oldCommit, to: newCommit });
    expect(dirty.status).toBe('skipped-dirty');
    expect(res.updatedProjects).toEqual([atm.projectId(dir)]);
    const lock = await readJson(path.join(dir, '.agents/tools.lock.json'));
    expect(lock.skills.one.commit).toBe(newCommit);
    expect(lock.skills.one.contextTokens).toBeGreaterThan(5);
    expect(env.events.some((e) => e.type === 'project.changed')).toBe(true);

    const again = await atm.sync([r1.bare]);
    expect(again.repos).toEqual([expect.objectContaining({ status: 'up-to-date' })]);
    expect(again.updatedProjects).toEqual([]);
  });
});

describe('measure', () => {
  it('measures a stdio MCP server via tools/list and writes the lock', async () => {
    const env = await setup({ FAKE_TOKEN: 'secret-value' });
    const { atm } = env;
    await write(
      path.join(env.registry, 'fake.json'),
      JSON.stringify({ name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_SERVER], env: { FAKE_TOKEN: '${FAKE_TOKEN}' } }),
    );
    const dir = await env.project();
    await atm.init(dir);
    await atm.add(dir, { kind: 'mcp', name: 'fake' });
    const r = await atm.measure(dir, 'fake');
    expect(r.name).toBe('fake');
    expect(r.toolCount).toBe(2);
    expect(r.contextTokens).toBeGreaterThan(20);
    const lock = await readJson(path.join(dir, '.agents/tools.lock.json'));
    expect(lock.mcp.fake.contextTokens).toBe(r.contextTokens);
    const detail = await atm.list(dir);
    expect(detail.context.mcp).toBe(r.contextTokens);
    expect(detail.context.unmeasured).toBe(0);
    // 定义不变时 install 保留测量结果
    await atm.install(dir);
    expect((await readJson(path.join(dir, '.agents/tools.lock.json'))).mcp.fake.contextTokens).toBe(r.contextTokens);
  });

  it('fails with UNSUPPORTED when env vars are missing, and doctor --measure keeps going', async () => {
    const env = await setup({});
    await write(path.join(env.registry, 'fake.json'), JSON.stringify({ name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE_SERVER], env: { FAKE_TOKEN: '${FAKE_TOKEN}' } }));
    const dir = await env.project();
    await env.atm.init(dir);
    await env.atm.add(dir, { kind: 'mcp', name: 'fake' });
    const lockBefore = await fs.readFile(path.join(dir, '.agents/tools.lock.json'), 'utf8');
    await expect(env.atm.measure(dir, 'fake')).rejects.toMatchObject({ code: 'UNSUPPORTED', candidates: ['FAKE_TOKEN'] });
    expect(await fs.readFile(path.join(dir, '.agents/tools.lock.json'), 'utf8')).toBe(lockBefore);
    const report = await env.atm.doctor(dir, { measure: true });
    expect(report.measured).toBe(true);
    expect(report.issues.find((i) => i.code === 'context-total')!.detail).toContain('FAKE_TOKEN');
  });
});

describe('pin', () => {
  it('creates a worktree and repoints the symlink', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'skills', { 'x/SKILL.md': skillMd('x', 'v1') });
    const v1 = git(remote.work, 'rev-parse', 'HEAD');
    git(remote.work, 'tag', 'v1');
    git(remote.work, 'push', '-q', 'origin', 'v1');
    await remote.commit({ 'x/SKILL.md': skillMd('x', 'v2') });
    const dir = await env.project();
    await env.atm.init(dir);
    await env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'x' });
    const dry = await env.atm.pin(dir, 'x', 'v1', { dryRun: true });
    expect(await exists(path.join(env.root, '.worktrees'))).toBe(false);
    const res = await env.atm.pin(dir, 'x', 'v1');
    expect(res.files).toEqual(dry.files);
    const wt = path.join(env.root, '.worktrees', 'skills@v1');
    expect(await fs.readlink(path.join(dir, '.agents/skills/x'))).toBe(path.join(wt, 'x'));
    expect(await fs.readFile(path.join(dir, '.agents/skills/x/SKILL.md'), 'utf8')).toContain('v1');
    const lock = await readJson(path.join(dir, '.agents/tools.lock.json'));
    // lock 会被提交：worktree 存相对 <root> 的路径，而不是本机绝对路径
    expect(lock.skills.x).toMatchObject({ rev: 'v1', commit: v1, worktree: '.worktrees/skills@v1' });
    expect(JSON.stringify(lock)).not.toContain(env.root);
    expect((await readJson(path.join(dir, '.agents/tools.json'))).skills[0]).toEqual({ repo: remote.bare, name: 'x', rev: 'v1' });
    // install 保持 pin，不产生变化
    expect((await env.atm.install(dir)).files).toEqual([]);
    expect((await env.atm.doctor(dir)).issues.filter((i) => i.code === 'rev-mismatch')).toEqual([]);
  });
});

describe('library, repos, global, migrate, batch, registry', () => {
  it('covers the GUI read APIs and multi-project writes', async () => {
    const env = await setup();
    const { atm, home } = env;
    const remote = await makeRemote(env.base, 'kit', {
      'skills/comic/SKILL.md': skillMd('comic', 'Comic strips'),
      'skills/cover/SKILL.md': skillMd('cover', 'Book covers'),
    });
    const cloned = await atm.cloneRepo(remote.bare);
    expect(cloned).toMatchObject({ dir: path.join(env.root, 'kit'), dirty: false, ahead: 0, branch: 'main' });
    await expect(atm.cloneRepo(remote.bare)).rejects.toMatchObject({ code: 'CONFLICT' });
    await write(path.join(env.registry, 'figma.json'), JSON.stringify({ name: 'figma', transport: 'stdio', command: 'npx', env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' } }));
    await writeInstalledPlugins(home, { 'p@m': { files: { 'skills/s/SKILL.md': skillMd('s', 'plugin skill') } } });
    await write(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'p@m': true }, other: 1 }, null, 2));
    await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true });
    await fs.symlink(path.join(env.root, 'kit/skills/comic'), path.join(home, '.claude/skills/comic'));

    const a = await env.project('a');
    const b = await env.project('b');
    await atm.init(a);
    await atm.init(b);

    const lib = await atm.library();
    expect(lib.filter((i) => i.kind === 'skill').map((i) => i.name).sort()).toEqual(['comic', 'cover']);
    expect(lib.find((i) => i.name === 'comic')).toMatchObject({ global: true, source: remote.bare, skill: { repoDir: path.join(env.root, 'kit') } });
    expect(lib.find((i) => i.kind === 'mcp')).toMatchObject({ name: 'figma', mcp: { origin: 'registry', envVars: [{ name: 'FIGMA_API_KEY', set: false }] } });
    expect(lib.filter((i) => i.kind === 'plugin')).toEqual([]);
    expect((await atm.library({ includeInstalledPlugins: true })).find((i) => i.kind === 'plugin')).toMatchObject({ name: 'p@m', global: true, contextTokens: expect.any(Number) });
    expect((await atm.search('cov')).items.map((i) => i.name)).toEqual(['cover']);
    expect((await atm.search('fgm')).items.map((i) => i.name)).toEqual(['figma']);

    const repos = await atm.repos();
    expect(repos.map((r) => r.dir)).toEqual([path.join(env.root, 'kit')]);

    // batch：一项失败不影响其他
    const batch = await atm.batch([
      { projectId: atm.projectId(a), action: 'add', spec: { kind: 'skill', repo: remote.bare, name: 'cover' } },
      { projectId: atm.projectId(b), action: 'add', spec: { kind: 'mcp', name: 'missing' } },
      { projectId: atm.projectId(b), action: 'add', spec: { kind: 'mcp', name: 'figma' } },
    ]);
    expect(batch.applied).toBe(true);
    expect(batch.results.map((r) => ('error' in r.result ? 'error' : 'ok'))).toEqual(['ok', 'error', 'ok']);
    expect((await atm.library()).find((i) => i.name === 'cover')!.usedBy).toEqual([atm.projectId(a)]);
    expect((await atm.repos())[0]!.usedBy).toEqual([atm.projectId(a)]);

    // global + migrate
    const g = await atm.global();
    expect(g.skills).toEqual([expect.objectContaining({ name: 'comic', target: path.join(env.root, 'kit/skills/comic'), shadowedBy: [] })]);
    expect(g.plugins).toEqual([{ name: 'p@m', installed: true, contextTokens: expect.any(Number), usedBy: [] }]);

    const spec = { kind: 'plugin' as const, name: 'p@m', projectIds: [atm.projectId(a), atm.projectId(b)], removeGlobal: true };
    const dryMig = await atm.migrate(spec, { dryRun: true });
    expect(dryMig.applied).toBe(false);
    expect(dryMig.files.map((f) => f.relPath)).toContain('~/.claude/settings.json');
    const mig = await atm.migrate(spec);
    expect(mig.files).toEqual(dryMig.files);
    const settings = await readJson(path.join(home, '.claude/settings.json'));
    expect(settings).toEqual({ enabledPlugins: {}, other: 1 });
    expect((await readJson(path.join(a, '.claude/settings.json'))).enabledPlugins).toEqual({ 'p@m': true });

    const migSkill = await atm.migrate({ kind: 'skill', name: 'comic', projectIds: [atm.projectId(b)], removeGlobal: true });
    expect(migSkill.applied).toBe(true);
    expect(await exists(path.join(home, '.claude/skills/comic'))).toBe(false);
    expect(await fs.readlink(path.join(b, '.agents/skills/comic'))).toBe(path.join(env.root, 'kit/skills/comic'));

    // registry 维护
    const moved = path.join(env.base, 'work', 'a-moved');
    await fs.rename(a, moved);
    expect((await atm.projects()).find((p) => p.id === atm.projectId(a))!.exists).toBe(false);
    const rel = await atm.relocateProject(atm.projectId(a), moved);
    expect(rel).toMatchObject({ path: moved, exists: true, initialized: true });
    expect(await atm.resolveProject(atm.projectId(moved))).toBe(moved);
    await atm.unregisterProject(moved);
    expect((await atm.config()).projects).toEqual([b]);
    await expect(atm.resolveProject('000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const cfg = await atm.saveConfig({ defaultAgents: ['cursor', 'codex'] });
    expect(cfg.defaultAgents).toEqual(['cursor', 'codex']);
    const raw = await readJson(path.join(home, '.config/atm/config.json'));
    expect(raw.projects).toEqual([path.relative(home, b).startsWith('..') ? b : `~/${path.relative(home, b)}`]);
  });

  it('config defaults derive from home', async () => {
    const env = await setup();
    expect(await env.atm.config()).toEqual({ root: env.root, mcpRegistry: env.registry, defaultAgents: ['claude-code'], projects: [] });
    await env.atm.saveConfig({ root: '~/code' });
    expect(await env.atm.config()).toMatchObject({ root: path.join(env.home, 'code'), mcpRegistry: path.join(env.home, 'code', 'mcp-registry') });
  });
});

describe('watch', () => {
  it('emits project.changed when the manifest changes', async () => {
    const env = await setup();
    const dir = await env.project();
    await env.atm.init(dir);
    const events: AtmEvent[] = [];
    const stop = env.atm.watch([dir], (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 200));
    await fs.writeFile(path.join(dir, '.agents/tools.json'), JSON.stringify({ agents: ['claude-code'] }));
    await fs.writeFile(path.join(dir, '.mcp.json'), '{}');
    for (let i = 0; i < 40 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(events).toContainEqual({ type: 'project.changed', projectId: env.atm.projectId(dir), reason: 'manifest' });
    expect(events).toContainEqual({ type: 'project.changed', projectId: env.atm.projectId(dir), reason: 'agent-config' });
  });
});

describe('resolver edge cases', () => {
  it('install re-clones a missing shared repo; an occupied directory is a CONFLICT', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'skills', { 'x/SKILL.md': skillMd('x', 'v1') });
    const dir = await env.project();
    await env.atm.init(dir);
    await env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'x' });
    await fs.rm(path.join(env.root, 'skills'), { recursive: true });
    // install 克隆缺失的仓库，软链目标恢复
    const inst = await env.atm.install(dir);
    expect(inst.files.map((f) => f.diff.split(' ')[0])).toEqual(['git']);
    expect(await fs.readFile(path.join(dir, '.agents/skills/x/SKILL.md'), 'utf8')).toContain('v1');

    const other = await makeRemote(env.base, 'other/skills', { 'y/SKILL.md': skillMd('y', 'y') });
    const err = await env.atm.add(dir, { kind: 'skill', repo: other.bare, name: 'y' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONFLICT' });
    expect((err as AtmError).nextCommand).toMatch(/^git clone /);
  });

  it('a real folder at the skill symlink path is a CONFLICT and is left untouched', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'skills', { 'x/SKILL.md': skillMd('x', 'v1') });
    const dir = await env.project();
    await env.atm.init(dir);
    await write(path.join(dir, '.agents/skills/x/SKILL.md'), 'hand-written');
    const manifestBefore = await fs.readFile(path.join(dir, '.agents/tools.json'), 'utf8');
    const err = await env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtmError);
    expect(err).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('real directory') });
    expect(await fs.readFile(path.join(dir, '.agents/skills/x/SKILL.md'), 'utf8')).toBe('hand-written');
    expect(await fs.readFile(path.join(dir, '.agents/tools.json'), 'utf8')).toBe(manifestBefore);
  });

  it('a folder without an origin remote is not accepted as the requested repo (CONFLICT)', async () => {
    const env = await setup();
    const remote = await makeRemote(env.base, 'skills', { 'x/SKILL.md': skillMd('x', 'v1') });
    // <root>/skills 存在，但不是这个仓库的克隆（没有 origin）
    const squatter = path.join(env.root, 'skills');
    await write(path.join(squatter, 'x/SKILL.md'), skillMd('x', 'impostor'));
    git(squatter, 'init', '-q');
    const dir = await env.project();
    await env.atm.init(dir);
    const err = await env.atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtmError);
    expect(err).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('no origin remote') });
    expect(await exists(path.join(dir, '.agents/skills/x'))).toBe(false);
    // 请求的就是这个本地目录本身时可以用
    const ok = await env.atm.add(dir, { kind: 'skill', repo: squatter, name: 'x' });
    expect(ok.applied).toBe(true);
    expect(await fs.readlink(path.join(dir, '.agents/skills/x'))).toBe(path.join(squatter, 'x'));
  });
});
