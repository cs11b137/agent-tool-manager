import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAtm, type AtmEvent } from '../src/index.js';
import { mkTmp, write } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const home = await mkTmp();
  const events: AtmEvent[] = [];
  const atm = createAtm({ home, onEvent: (event) => events.push(event) });
  const configPath = path.join(home, '.config/atm/config.json');
  return { home, atm, events, configPath };
}

describe('shared directory initialization', () => {
  it('uses the new default without creating it on read; retains explicit legacy paths', async () => {
    const { home, atm } = await fixture();
    expect(await atm.config()).toMatchObject({ root: path.join(home, '.agent-tools'), mcpRegistry: path.join(home, '.agent-tools/mcp-registry') });
    await expect(fs.stat(path.join(home, '.agent-tools'))).rejects.toMatchObject({ code: 'ENOENT' });
    await atm.saveConfig({ root: '~/GitHub', mcpRegistry: '~/custom-registry' });
    expect(await atm.config()).toMatchObject({ root: path.join(home, 'GitHub'), mcpRegistry: path.join(home, 'custom-registry') });
  });

  it('creates defaults, preserves other settings and content, and is idempotent', async () => {
    const { home, atm, events, configPath } = await fixture();
    await atm.saveConfig({ defaultAgents: ['codex'], projects: ['~/project'] });
    const input = { root: ' ~/.agent-tools ', mcpRegistry: '~/.agent-tools/mcp-registry' };
    const cfg = await atm.initSharedDirectory(input);
    expect(cfg).toMatchObject({ root: path.join(home, '.agent-tools'), defaultAgents: ['codex'], projects: [path.join(home, 'project')] });
    expect((await fs.stat(cfg.mcpRegistry)).isDirectory()).toBe(true);
    await write(path.join(cfg.root, 'existing.txt'), 'keep');
    const before = await fs.readFile(configPath, 'utf8');
    expect(await atm.initSharedDirectory(input)).toEqual(cfg);
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(cfg.root, 'existing.txt'), 'utf8')).toBe('keep');
    expect(events.filter((e) => e.type === 'library.changed')).toHaveLength(2);
  });

  it('supports independent absolute paths and valid directory symlinks', async () => {
    const { home, atm } = await fixture();
    await fs.mkdir(path.join(home, 'actual'));
    await fs.symlink(path.join(home, 'actual'), path.join(home, 'linked'));
    const cfg = await atm.initSharedDirectory({ root: path.join(home, 'linked/nested'), mcpRegistry: path.join(home, 'registry/deep') });
    expect((await fs.stat(path.join(home, 'actual/nested'))).isDirectory()).toBe(true);
    expect((await fs.stat(cfg.mcpRegistry)).isDirectory()).toBe(true);
  });

  it.each(['', '  ', 'relative/path', '~someone/tools', '/bad\0path'])('rejects invalid paths: %j', async (root) => {
    const { atm, configPath } = await fixture();
    await expect(atm.initSharedDirectory({ root, mcpRegistry: '~/registry' })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['file', 'broken-link'])('rolls back directories when registry is blocked by %s', async (kind) => {
    const { home, atm, configPath, events } = await fixture();
    await atm.saveConfig({ root: '~/old' });
    const before = await fs.readFile(configPath, 'utf8');
    const blocked = path.join(home, 'blocked');
    if (kind === 'file') await write(blocked, 'keep');
    else await fs.symlink(path.join(home, 'missing-target'), blocked);
    await expect(atm.initSharedDirectory({ root: '~/new/deep/root', mcpRegistry: '~/blocked/registry' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    await expect(fs.stat(path.join(home, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.lstat(blocked)).toBeDefined();
    expect(events).toHaveLength(0);
  });

  it('rolls back on config write failure without deleting preexisting directories', async () => {
    const { home, atm, configPath } = await fixture();
    await atm.saveConfig({ root: '~/old' });
    const before = await fs.readFile(configPath, 'utf8');
    await fs.mkdir(path.join(home, 'existing'));
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('config write denied'), { code: 'EACCES' }));
    await expect(atm.initSharedDirectory({ root: '~/existing/new/root', mcpRegistry: '~/registry/nested' })).rejects.toThrow('权限');
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    expect(await fs.readdir(path.join(home, 'existing'))).toEqual([]);
    await expect(fs.stat(path.join(home, 'registry'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an existing directory without write permission and preserves its contents', async () => {
    const { home, atm, configPath } = await fixture();
    await atm.saveConfig({ root: '~/old' });
    const before = await fs.readFile(configPath, 'utf8');
    await write(path.join(home, 'existing/keep.txt'), 'keep');
    vi.spyOn(fs, 'access').mockRejectedValueOnce(Object.assign(new Error('existing directory denied'), { code: 'EACCES' }));
    await expect(atm.initSharedDirectory({ root: '~/existing', mcpRegistry: '~/existing/mcp-registry' })).rejects.toThrow('权限');
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    expect(await fs.readdir(path.join(home, 'existing'))).toEqual(['keep.txt']);
  });

  it('retains newly created directories if other content arrives before rollback', async () => {
    const { home, atm } = await fixture();
    await atm.saveConfig({});
    vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      await fs.writeFile(path.join(home, 'new', 'keep.txt'), 'concurrent content');
      throw new Error('save failed');
    });
    await expect(atm.initSharedDirectory({ root: '~/new', mcpRegistry: '~/new/mcp-registry' })).rejects.toThrow('save failed');
    expect(await fs.readFile(path.join(home, 'new/keep.txt'), 'utf8')).toBe('concurrent content');
    await expect(fs.stat(path.join(home, 'new/mcp-registry'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back when creating the second directory is denied', async () => {
    const { home, atm } = await fixture();
    const original = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (dir, options) => {
      if (dir === path.join(home, 'denied')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(dir, options);
    });
    await expect(atm.initSharedDirectory({ root: '~/new/deep', mcpRegistry: '~/denied' })).rejects.toThrow('权限');
    await expect(fs.stat(path.join(home, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
