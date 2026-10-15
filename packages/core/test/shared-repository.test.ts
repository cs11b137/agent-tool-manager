import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAtm } from '../src/index.js';
import { exists, git, mkTmp, readJson, setup, treeSnapshot, write, writeInstalledPlugins } from './helpers.js';

describe('shared repository workflow', () => {
  it('starts empty, explicitly creates a Git repository, and is idempotent without importing native plugins', async () => {
    const home = await mkTmp();
    await writeInstalledPlugins(home, { 'native@market': {} });
    const atm = createAtm({ home });
    const cfg = await atm.config();
    expect(await atm.library()).toEqual([]);
    expect(await atm.projects()).toEqual([]);
    expect((await atm.sharedRepository()).initialized).toBe(false);
    expect(await exists(cfg.root)).toBe(false);
    await expect(atm.createSharedTool({ kind: 'skill', name: 'test', description: 'Test', content: 'Hello' })).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    await atm.initSharedRepository(cfg);
    const first = await treeSnapshot(cfg.root);
    await atm.initSharedRepository(cfg);
    expect(await treeSnapshot(cfg.root)).toEqual(first);
    expect((await atm.sharedRepository()).initialized).toBe(true);
    expect(await atm.library()).toEqual([]);
    expect(await atm.projects()).toEqual([]);
  });

  it('updates paths and default agents together, preserving the previous configuration on failure', async () => {
    const e = await setup();
    await e.atm.initSharedRepository({ root: e.root, mcpRegistry: e.registry });
    await write(path.join(e.root, 'keep.txt'), 'keep');
    const before = await e.atm.config();
    const nextRoot = path.join(e.home, 'updated-repository');
    const conflict = path.join(e.home, 'registry-file');
    await write(conflict, 'file');
    await expect(e.atm.initSharedRepository({ root: nextRoot, mcpRegistry: conflict, defaultAgents: ['cursor'] })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await e.atm.config()).toEqual(before);
    expect(await exists(nextRoot)).toBe(false);
    const after = await e.atm.initSharedRepository({ root: nextRoot, mcpRegistry: path.join(nextRoot, 'registry'), defaultAgents: ['cursor'] });
    expect(after).toMatchObject({ root: nextRoot, defaultAgents: ['cursor'], projects: before.projects, sharedRepository: true });
    expect((await e.atm.sharedRepository()).initialized).toBe(true);
    expect(await fs.readFile(path.join(e.root, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('creates all tool types, associates them with projects, and preserves manual settings on removal', async () => {
    const e = await setup();
    await e.atm.initSharedRepository({ root: e.root, mcpRegistry: e.registry });
    await e.atm.createSharedTool({ kind: 'skill', name: 'review', description: 'Review code', content: '# Review\nCheck changes.' });
    await e.atm.createSharedTool({ kind: 'plugin', name: 'team', description: 'Team tools', content: '# Team\nUse team conventions.' });
    await e.atm.createSharedTool({ kind: 'mcp', def: { name: 'docs', transport: 'http', url: 'https://example.com/mcp' } });
    expect((await e.atm.library()).map((i) => i.name).sort()).toEqual(['docs', 'review', 'team@atm-shared']);
    expect(await readJson(path.join(e.root, '.claude-plugin/marketplace.json'))).toMatchObject({ name: 'atm-shared', plugins: [{ name: 'team', source: './plugins/team' }] });
    const dir = await e.project();
    await write(path.join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, extraKnownMarketplaces: { manual: { source: { source: 'directory', path: '/manual' } } } }));
    await e.atm.init(dir);
    await e.atm.registerProject(dir);
    for (const spec of [{ kind: 'skill', repo: 'atm:shared', name: 'review' }, { kind: 'mcp', name: 'docs' }, { kind: 'plugin', name: 'team@atm-shared' }] as const) {
      const before = await treeSnapshot(dir);
      await e.atm.add(dir, spec, { dryRun: true });
      expect(await treeSnapshot(dir)).toEqual(before);
      await e.atm.add(dir, spec);
    }
    expect(await fs.realpath(path.join(dir, '.agents/skills/review'))).toBe(path.join(e.root, 'skills/review'));
    const settings = await readJson(path.join(dir, '.claude/settings.json'));
    expect(settings.enabledPlugins['team@atm-shared']).toBe(true);
    expect(settings.extraKnownMarketplaces['atm-shared'].source.path).toBe(e.root);
    expect((await e.atm.list(dir)).tools).toHaveLength(3);
    await e.atm.remove(dir, 'team@atm-shared', { kind: 'plugin' });
    const removed = await readJson(path.join(dir, '.claude/settings.json'));
    expect(removed.extraKnownMarketplaces['atm-shared']).toBeUndefined();
    expect(removed.extraKnownMarketplaces.manual).toBeDefined();
    expect(removed.permissions).toEqual({ allow: ['Read'] });
  });

  it('rejects duplicate names and unsafe paths without changing existing tools', async () => {
    const e = await setup();
    await e.atm.initSharedRepository({ root: e.root, mcpRegistry: e.registry });
    const input = { kind: 'skill', name: 'review', description: 'Review', content: 'Check' } as const;
    await e.atm.createSharedTool(input);
    const before = await treeSnapshot(e.root);
    await expect(e.atm.createSharedTool(input)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    await expect(e.atm.createSharedTool({ ...input, name: '../outside' })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    expect(await treeSnapshot(e.root)).toEqual(before);
    const outside = await e.project('outside');
    await fs.symlink(outside, path.join(e.root, 'plugins'));
    await expect(e.atm.createSharedTool({ ...input, kind: 'plugin' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('commits only managed changes, preserves unrelated staging, and pushes to a local remote', async () => {
    const e = await setup();
    await e.atm.initSharedRepository({ root: e.root, mcpRegistry: e.registry });
    await write(path.join(e.root, 'private.txt'), 'not a shared tool');
    git(e.root, 'add', 'private.txt');
    await e.atm.createSharedTool({ kind: 'skill', name: 'review', description: 'Review', content: 'Check' });
    await e.atm.commitSharedRepository('Create tools');
    expect(git(e.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('skills/review/SKILL.md');
    expect(git(e.root, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('private.txt');
    expect(git(e.root, 'diff', '--cached', '--name-only')).toBe('private.txt');
    const remote = path.join(e.base, 'remote.git');
    await fs.mkdir(remote);
    git(remote, 'init', '--bare', '-b', 'main');
    await e.atm.setSharedRemote(remote);
    await e.atm.pushSharedRepository();
    expect(git(remote, 'rev-parse', 'main')).toBe(git(e.root, 'rev-parse', 'HEAD'));
    await write(path.join(e.root, 'skills/review/a file.md'), 'space');
    expect((await e.atm.sharedRepository()).changes).toContain('skills/review/a file.md');
    await e.atm.commitSharedRepository('Add file with spaces');
    await fs.unlink(path.join(e.root, 'skills/review/a file.md'));
    expect((await e.atm.sharedRepository()).changes).toContain('skills/review/a file.md');
    await e.atm.commitSharedRepository('Remove file');
    await e.atm.setSharedRemote(path.join(e.base, 'missing.git'));
    await expect(e.atm.pushSharedRepository()).rejects.toMatchObject({ code: 'GIT_FAILED' });
    expect((await e.atm.sharedRepository()).head).toBe(git(e.root, 'rev-parse', 'HEAD'));
    await e.atm.setSharedRemote(remote);
    await e.atm.pushSharedRepository();
  });

  it('preserves old paths and settings; a failed initialization leaves config and content untouched', async () => {
    const e = await setup();
    const dir = await e.project();
    await e.atm.saveConfig({ defaultAgents: ['codex'], projects: [dir] });
    await write(path.join(e.root, 'existing.txt'), 'keep');
    const cfg = await e.atm.config();
    await write(path.join(e.root, '.git'), 'invalid git file');
    const before = await treeSnapshot(e.root);
    await expect(e.atm.initSharedRepository(cfg)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await e.atm.config()).toEqual(cfg);
    expect(await treeSnapshot(e.root)).toEqual(before);
    await fs.unlink(path.join(e.root, '.git'));
    await e.atm.initSharedRepository(cfg);
    expect(await e.atm.config()).toMatchObject({ defaultAgents: ['codex'], projects: [dir], sharedRepository: true });
    expect(await fs.readFile(path.join(e.root, 'existing.txt'), 'utf8')).toBe('keep');
    await e.atm.saveConfig({ root: path.join(e.home, 'other') });
    expect((await e.atm.sharedRepository()).initialized).toBe(false);
  });
  it('rolls back new Git files and directories if atomic config persistence fails', async () => {
    const e = await setup();
    const before = await e.atm.config();
    const nextRoot = path.join(e.home, 'new', 'tools');
    const original = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('/atm/config.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return original(from, to);
    });
    try {
      await expect(e.atm.initSharedRepository({ root: nextRoot, mcpRegistry: path.join(nextRoot, 'mcp-registry') })).rejects.toThrow('disk full');
    } finally { rename.mockRestore(); }
    expect(await exists(path.join(e.home, 'new'))).toBe(false);
    expect(await e.atm.config()).toEqual(before);
  });

  it('keeps external registries external, validates remote input, and preserves config on tool conflicts', async () => {
    const e = await setup();
    const external = path.join(e.home, 'external-registry');
    await e.atm.initSharedRepository({ root: e.root, mcpRegistry: external });
    const cfg = await e.atm.config();
    expect((await e.atm.sharedRepository()).registryIncluded).toBe(false);
    await e.atm.createSharedTool({ kind: 'mcp', def: { name: 'docs', transport: 'http', url: 'https://example.com/mcp' } });
    expect(await exists(path.join(external, 'docs.json'))).toBe(true);
    expect((await e.atm.sharedRepository()).changes).not.toContain('docs.json');
    await expect(e.atm.createSharedTool({ kind: 'mcp', def: { name: 'docs', transport: 'http', url: 'https://example.com/new' } })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    for (const remote of ['', '--upload-pack=bad', 'https://', 'https://token@github.com/org/repo', 'ext::bad']) {
      await expect(e.atm.setSharedRemote(remote)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    }
    expect(await e.atm.config()).toEqual(cfg);
  });

  it('preserves legacy local skill sources when the parent becomes a Git repository', async () => {
    const e = await setup();
    const legacy = path.join(e.root, 'legacy');
    await write(path.join(legacy, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nReview code.');
    const project = await e.project();
    await e.atm.init(project);
    await e.atm.add(project, { kind: 'skill', name: 'review', repo: legacy });
    await e.atm.initSharedRepository({ root: e.root, mcpRegistry: e.registry });
    await e.atm.setSharedRemote('git@github.com:example/shared-tools.git');
    const item = (await e.atm.library()).find((i) => i.name === 'review')!;
    expect(item.skill?.repo).toBe(legacy);
    expect(item.usedBy).toContain(e.atm.projectId(project));
    expect(await fs.realpath(path.join(project, '.agents/skills/review'))).toBe(path.join(legacy, 'review'));
  });

});
