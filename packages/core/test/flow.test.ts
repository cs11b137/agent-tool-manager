import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtmError, projectId } from '../src/index.js';
import { exists, makeRemote, readJson, setup, skillMd, treeSnapshot, write, writeInstalledPlugins } from './helpers.js';

async function fixture() {
  const env = await setup();
  const remote = await makeRemote(env.base, 'baoyu-skills', {
    'skills/baoyu-comic/SKILL.md': skillMd('baoyu-comic', 'Turn a story into a comic strip'),
    'skills/design/baoyu-cover/SKILL.md': skillMd('baoyu-cover', '封面生成'),
    'README.md': '# skills\n',
  });
  await write(
    path.join(env.registry, 'figma.json'),
    JSON.stringify({ name: 'figma', transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'], env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' } }),
  );
  await write(path.join(env.registry, 'linear.json'), JSON.stringify({ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } }));
  await writeInstalledPlugins(env.home, {
    'security-guidance@claude-plugins-official': {
      files: { 'skills/sec/SKILL.md': skillMd('sec-review', 'Security review checklist'), 'commands/audit.md': '# audit', 'hooks/hooks.json': '{}' },
    },
  });
  const dir = await env.project();
  return { ...env, remote, dir };
}

describe('full flow', () => {
  it('init → add skill → add mcp → add plugin → list → remove → install', async () => {
    const { atm, dir, remote, root, events, home } = await fixture();

    // init
    const init = await atm.init(dir);
    expect(init.applied).toBe(true);
    expect(await readJson(path.join(dir, '.agents/tools.json'))).toMatchObject({ agents: ['claude-code'], skills: [], mcp: [], plugins: [] });
    expect(await fs.readlink(path.join(dir, '.claude/skills'))).toBe(path.join('..', '.agents', 'skills'));
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toContain('.agents/skills/\n.claude/skills\n');
    expect((await atm.config()).projects).toEqual([dir]);
    // init 是幂等的
    expect((await atm.init(dir)).files).toEqual([]);

    // add skill（从本地 bare 仓库克隆）
    const addSkill = await atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'baoyu-cover' });
    const repoDir = path.join(root, 'baoyu-skills');
    expect(addSkill.files[0]).toMatchObject({ type: 'dir', path: repoDir });
    expect(await fs.readlink(path.join(dir, '.agents/skills/baoyu-cover'))).toBe(path.join(repoDir, 'skills/design/baoyu-cover'));
    const lock1 = await readJson(path.join(dir, '.agents/tools.lock.json'));
    expect(lock1.skills['baoyu-cover']).toMatchObject({ repo: remote.bare, path: 'skills/design/baoyu-cover', commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(lock1.skills['baoyu-cover'].contextTokens).toBeGreaterThan(0);
    expect(addSkill.contextAfter?.skill).toBe(lock1.skills['baoyu-cover'].contextTokens);

    // add mcp：先写一个手写条目，验证不被改动
    await write(path.join(dir, '.mcp.json'), '{\n    "mcpServers": {\n        "hand": { "command": "mine" }\n    }\n}\n');
    const addMcp = await atm.add(dir, { kind: 'mcp', name: 'figma' });
    expect(addMcp.files.map((f) => f.relPath)).toEqual(['.mcp.json', '.agents/tools.json', '.agents/tools.lock.json']);
    expect(addMcp.files[0]!.agent).toBe('claude-code');
    expect(addMcp.files[0]!.diff).toContain('+        "figma": {');
    const mcpJson = await readJson(path.join(dir, '.mcp.json'));
    expect(Object.keys(mcpJson.mcpServers)).toEqual(['hand', 'figma']);
    expect(mcpJson.mcpServers.figma.env).toEqual({ FIGMA_API_KEY: '${FIGMA_API_KEY}' });
    expect(addMcp.contextAfter?.unmeasured).toBe(1);

    // add plugin
    const addPlugin = await atm.add(dir, { kind: 'plugin', name: 'security-guidance@claude-plugins-official' });
    expect(addPlugin.files.map((f) => f.relPath)).toContain('.claude/settings.json');
    expect((await readJson(path.join(dir, '.claude/settings.json'))).enabledPlugins).toEqual({ 'security-guidance@claude-plugins-official': true });
    await expect(atm.add(dir, { kind: 'plugin', name: 'nope@x' })).rejects.toMatchObject({ code: 'PLUGIN_NOT_INSTALLED', nextCommand: '/plugin install nope@x' });

    // list
    const detail = await atm.list(dir);
    expect(detail.id).toBe(projectId(dir));
    expect(detail.counts).toEqual({ skills: 1, mcp: 1, plugins: 1 });
    expect(detail.tools.map((t) => `${t.kind}:${t.name}`)).toEqual(['skill:baoyu-cover', 'mcp:figma', 'plugin:security-guidance@claude-plugins-official']);
    const skill = detail.tools[0]!.skill!;
    expect(skill).toMatchObject({ linked: true, broken: false, description: '封面生成', path: 'skills/design/baoyu-cover' });
    const mcp = detail.tools[1]!;
    expect(mcp.contextTokens).toBeNull();
    expect(mcp.mcp).toMatchObject({ origin: 'registry', transport: 'stdio', envVars: [{ name: 'FIGMA_API_KEY', set: false }] });
    const plugin = detail.tools[2]!;
    expect(plugin.plugin).toMatchObject({ installed: true, marketplace: 'claude-plugins-official', globallyEnabled: false });
    expect(plugin.plugin!.contents).toMatchObject({ skills: [{ name: 'sec-review' }], commands: ['audit'], hooks: true });
    expect(detail.context.total).toBe(detail.context.skill + detail.context.plugin);
    expect(detail.issues.filter((i) => i.level === 'error')).toEqual([]);
    const summaries = await atm.projects();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ exists: true, initialized: true, counts: { skills: 1, mcp: 1, plugins: 1 } });

    // remove（自动判断类型）
    const rm = await atm.remove(dir, 'figma');
    expect(rm.files.map((f) => f.relPath)).toEqual(['.mcp.json', '.agents/tools.json', '.agents/tools.lock.json']);
    expect(Object.keys((await readJson(path.join(dir, '.mcp.json'))).mcpServers)).toEqual(['hand']);
    await atm.remove(dir, 'baoyu-cover');
    expect(await exists(path.join(dir, '.agents/skills/baoyu-cover'))).toBe(false);
    await expect(atm.remove(dir, 'baoyu-cover')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // install：删掉软链与生成的配置后重新还原，并且幂等
    await atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'baoyu-comic' });
    await atm.add(dir, { kind: 'mcp', name: 'linear', agents: ['claude-code', 'cursor'] });
    await fs.rm(path.join(dir, '.agents/skills'), { recursive: true });
    await fs.rm(path.join(dir, '.cursor'), { recursive: true });
    const inst = await atm.install(dir);
    expect(inst.files.map((f) => f.relPath)).toEqual(['.agents/skills', '.agents/skills/baoyu-comic', '.cursor/mcp.json']);
    expect((await readJson(path.join(dir, '.cursor/mcp.json'))).mcpServers.linear.headers).toEqual({ Authorization: 'Bearer ${env:LINEAR_TOKEN}' });
    expect((await atm.install(dir)).files).toEqual([]);

    // 事件
    expect(events.filter((e) => e.type === 'activity').length).toBeGreaterThanOrEqual(8);
    expect(events).toContainEqual({ type: 'project.changed', projectId: projectId(dir), reason: 'manifest' });
    expect(events).toContainEqual({ type: 'project.changed', projectId: projectId(dir), reason: 'agent-config' });
    expect(await exists(path.join(dir, '.agents/.lock'))).toBe(false);
    void home;
  });

  it('dryRun returns identical FileChange[] without touching disk', async () => {
    const { atm, dir, remote, base } = await fixture();
    await atm.init(dir);
    const before = await treeSnapshot(base);
    const dryInit = await atm.init(dir, { dryRun: true });
    expect(dryInit.files).toEqual([]);

    const spec = { kind: 'skill', repo: remote.bare, name: 'baoyu-comic' } as const;
    const dry = await atm.add(dir, spec, { dryRun: true });
    expect(dry.applied).toBe(false);
    expect(await treeSnapshot(base)).toEqual(before);
    const real = await atm.add(dir, spec);
    expect(real.applied).toBe(true);
    expect(real.files).toEqual(dry.files);

    const mcpBefore = await treeSnapshot(base);
    const dryMcp = await atm.add(dir, { kind: 'mcp', name: 'figma', agents: ['claude-code', 'cursor', 'codex'] }, { dryRun: true });
    expect(await treeSnapshot(base)).toEqual(mcpBefore);
    const realMcp = await atm.add(dir, { kind: 'mcp', name: 'figma', agents: ['claude-code', 'cursor', 'codex'] });
    expect(realMcp.files).toEqual(dryMcp.files);
    expect(realMcp.files.map((f) => f.relPath)).toEqual(['.mcp.json', '.cursor/mcp.json', '.codex/config.toml', '.agents/tools.json', '.agents/tools.lock.json']);

    const rmBefore = await treeSnapshot(base);
    const dryRm = await atm.remove(dir, 'baoyu-comic', { dryRun: true });
    expect(await treeSnapshot(base)).toEqual(rmBefore);
    expect((await atm.remove(dir, 'baoyu-comic')).files).toEqual(dryRm.files);
    expect(await atm.diffGenerated(dir)).toEqual([]);
  });

  it('init dryRun on a fresh project does not touch disk; init migrates a real .claude/skills dir', async () => {
    const { atm, dir, base } = await fixture();
    await write(path.join(dir, '.claude/skills/local-skill/SKILL.md'), skillMd('local-skill', 'x'));
    await fs.symlink('/somewhere/else', path.join(dir, '.claude/skills/linked'));
    const before = await treeSnapshot(base);
    const dry = await atm.init(dir, { dryRun: true });
    expect(await treeSnapshot(base)).toEqual(before);
    const real = await atm.init(dir);
    expect(real.files).toEqual(dry.files);
    expect(await fs.readlink(path.join(dir, '.claude/skills'))).toBe(path.join('..', '.agents', 'skills'));
    expect(await fs.readFile(path.join(dir, '.agents/skills/local-skill/SKILL.md'), 'utf8')).toContain('local-skill');
    expect(await fs.readlink(path.join(dir, '.agents/skills/linked'))).toBe('/somewhere/else');
  });

  it('init refuses to migrate when names collide', async () => {
    const { atm, dir } = await fixture();
    await write(path.join(dir, '.claude/skills/dup/SKILL.md'), 'x');
    await write(path.join(dir, '.agents/skills/dup/SKILL.md'), 'y');
    await expect(atm.init(dir)).rejects.toMatchObject({ code: 'CONFLICT', candidates: ['dup'] });
    expect((await fs.lstat(path.join(dir, '.claude/skills'))).isDirectory()).toBe(true);
  });

  it('hand-written MCP entry → CONFLICT, --adopt takes it over', async () => {
    const { atm, dir } = await fixture();
    await atm.init(dir);
    await write(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { figma: { command: 'old' } } }, null, 2));
    const err = await atm.add(dir, { kind: 'mcp', name: 'figma' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtmError);
    expect(err).toMatchObject({ code: 'CONFLICT', nextCommand: 'atm add mcp figma --adopt' });
    // 失败时清单与 lock 都不变
    expect((await readJson(path.join(dir, '.agents/tools.json'))).mcp).toEqual([]);
    const ok = await atm.add(dir, { kind: 'mcp', name: 'figma' }, { adopt: true });
    expect(ok.command).toBe('atm add mcp figma --adopt');
    expect((await readJson(path.join(dir, '.mcp.json'))).mcpServers.figma.command).toBe('npx');
    expect((await readJson(path.join(dir, '.agents/tools.lock.json'))).managed['claude-code'].mcp).toEqual(['figma']);
  });

  it('remove with the same name across kinds is AMBIGUOUS', async () => {
    const { atm, dir, remote, registry } = await fixture();
    await atm.init(dir);
    await write(path.join(registry, 'baoyu-comic.json'), JSON.stringify({ name: 'baoyu-comic', transport: 'stdio', command: 'x' }));
    await atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'baoyu-comic' });
    await atm.add(dir, { kind: 'mcp', name: 'baoyu-comic' });
    await expect(atm.remove(dir, 'baoyu-comic')).rejects.toMatchObject({ code: 'AMBIGUOUS', candidates: ['skill:baoyu-comic', 'mcp:baoyu-comic'] });
    const r = await atm.remove(dir, 'baoyu-comic', { kind: 'mcp' });
    expect(r.applied).toBe(true);
  });

  it('errors carry nextCommand: NOT_INITIALIZED, NOT_FOUND mcp', async () => {
    const { atm, dir } = await fixture();
    await expect(atm.add(dir, { kind: 'mcp', name: 'figma' })).rejects.toMatchObject({ code: 'NOT_INITIALIZED', nextCommand: 'atm init' });
    await atm.init(dir);
    const e = (await atm.add(dir, { kind: 'mcp', name: 'nope' }).catch((x: unknown) => x)) as AtmError;
    expect(e.code).toBe('NOT_FOUND');
    expect(e.candidates).toEqual(['figma', 'linear']);
    expect(e.toJSON().error.nextCommand).toContain('.agents/mcp/nope.json');
    await write(path.join(dir, '.agents/tools.json'), '{"agents": ["vim"]}');
    await expect(atm.list(dir)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    await expect(atm.doctor(dir)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it('project-level MCP definitions override the registry; setAgents re-renders', async () => {
    const { atm, dir } = await fixture();
    await atm.init(dir);
    await atm.saveMcpDef({ name: 'figma', transport: 'stdio', command: 'local-figma' }, { projectDir: dir });
    await atm.add(dir, { kind: 'mcp', name: 'figma' });
    expect((await readJson(path.join(dir, '.mcp.json'))).mcpServers.figma).toEqual({ command: 'local-figma' });
    expect((await atm.list(dir)).tools[0]!.source).toBe('project');
    const r = await atm.setAgents(dir, ['cursor']);
    expect(r.files.map((f) => f.relPath)).toEqual(['.cursor/skills', '.mcp.json', '.cursor/mcp.json', '.gitignore', '.agents/tools.json', '.agents/tools.lock.json']);
    expect((await readJson(path.join(dir, '.mcp.json'))).mcpServers).toEqual({});
    await expect(atm.saveMcpDef({ name: 'bad', transport: 'stdio', command: 'x', env: { K: 'literal' } }, 'registry')).rejects.toMatchObject({ code: 'INVALID_MCP_DEF' });
  });
});
