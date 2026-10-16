import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setup, treeSnapshot, write } from './helpers.js';
import { zipFixture } from './zip-fixture.js';
import type { ToolPackageSource } from '../src/types.js';
import * as download from '../src/ops/package-download.js';

const skill = '---\nname: review\ndescription: Code review\n---\nReview code.';
const upload = (entries: Parameters<typeof zipFixture>[0] = [{ name: 'SKILL.md', text: skill }]): ToolPackageSource => ({ type: 'upload', filename: 'tools.zip', base64: zipFixture(entries).toString('base64') });
async function fixture() { const e = await setup(); await e.atm.initSharedRepository({ root: e.root, mcpRegistry: e.registry }); return e; }
afterEach(() => vi.restoreAllMocks());

describe('tool packages', () => {
  it('previews without writes, installs wrapped mixed tools with assets and links them to a project', async () => {
    const e = await fixture();
    const source = upload([
      { name: 'release/skills/review/SKILL.md', text: skill },
      { name: 'release/skills/review/scripts/check.sh', text: '#!/bin/sh\nexit 0', mode: 0o100755 },
      { name: 'release/plugins/helper/.claude-plugin/plugin.json', text: '{"name":"helper","version":"1.2.0"}' },
      { name: 'release/plugins/helper/skills/nested/SKILL.md', text: '---\nname: nested\n---\nNested' },
      { name: 'release/plugins/helper/hooks/hooks.json', text: '{"hooks":{}}' },
      { name: 'release/mcp-registry/docs.json', text: '{"name":"docs","url":"https://example.com/mcp"}' },
    ]);
    const before = await treeSnapshot(e.root);
    const preview = await e.atm.importToolPackage({ source });
    expect(preview.installed).toBe(false);
    expect(preview.tools.map((t) => t.name).sort()).toEqual(['docs', 'helper', 'review']);
    expect(await treeSnapshot(e.root)).toEqual(before);
    expect((await e.atm.importToolPackage({ source, sha256: preview.sha256 })).installed).toBe(true);
    expect(await fs.readFile(path.join(e.root, 'skills/review/scripts/check.sh'), 'utf8')).toContain('exit 0');
    expect((await fs.stat(path.join(e.root, 'skills/review/scripts/check.sh'))).mode & 0o111).toBe(0o111);
    expect(JSON.parse(await fs.readFile(path.join(e.root, '.claude-plugin/marketplace.json'), 'utf8')).plugins).toEqual([{ name: 'helper', source: './plugins/helper' }]);
    const library = await e.atm.library();
    expect(library.map((t) => t.name)).toEqual(expect.arrayContaining(['review', 'docs', 'helper@atm-shared']));
    const project = await e.project();
    await e.atm.init(project);
    await e.atm.add(project, { kind: 'skill', name: 'review', repo: 'atm:shared' });
    expect(await fs.realpath(path.join(project, '.agents/skills/review'))).toBe(path.join(e.root, 'skills/review'));
  });

  it('installs deflated ZIPs under a configured root reached through a symlink', async () => {
    const e = await fixture();
    const alias = path.join(e.home, 'alias');
    await fs.symlink(e.root, alias);
    await e.atm.initSharedRepository({ root: alias, mcpRegistry: e.registry });
    const source = upload([{ name: 'SKILL.md', text: skill, compress: true }]);
    const preview = await e.atm.importToolPackage({ source });
    await e.atm.importToolPackage({ source, sha256: preview.sha256 });
    expect(await fs.readFile(path.join(e.root, 'skills/review/SKILL.md'), 'utf8')).toBe(skill);
  });

  it('preserves an existing tool and refuses the entire package on a conflict', async () => {
    const e = await fixture();
    const source = upload();
    const preview = await e.atm.importToolPackage({ source });
    await e.atm.importToolPackage({ source, sha256: preview.sha256 });
    const before = await treeSnapshot(e.root);
    expect((await e.atm.importToolPackage({ source })).tools[0]?.conflict).toBe(true);
    await expect(e.atm.importToolPackage({ source, sha256: preview.sha256 })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await treeSnapshot(e.root)).toEqual(before);
  });

  it('downloads an archive and rejects changed bytes between preview and install', async () => {
    const e = await fixture();
    const spy = vi.spyOn(download, 'downloadPackage').mockResolvedValue(zipFixture([{ name: 'SKILL.md', text: skill }]));
    const source = { type: 'url' as const, url: 'https://example.com/tools.zip' };
    const preview = await e.atm.importToolPackage({ source });
    spy.mockResolvedValue(zipFixture([{ name: 'SKILL.md', text: skill + 'changed' }]));
    await expect(e.atm.importToolPackage({ source, sha256: preview.sha256 })).rejects.toMatchObject({ code: 'CONFLICT' });
    spy.mockResolvedValue(zipFixture([{ name: 'SKILL.md', text: skill }]));
    expect((await e.atm.importToolPackage({ source, sha256: preview.sha256 })).installed).toBe(true);
  });

  it.each([
    [{ name: '../outside/SKILL.md', text: skill }],
    [{ name: '/absolute/SKILL.md', text: skill }],
    [{ name: 'C:/SKILL.md', text: skill }],
    [{ name: 'folder\\SKILL.md', text: skill }],
    [{ name: 'SKILL.md', text: skill }, { name: 'link', text: '/tmp', mode: 0o120777 }],
    [{ name: 'SKILL.md', text: skill }, { name: 'skill.md', text: skill }],
    [{ name: 'SKILL.md', text: skill, size: 51 * 1024 * 1024 }],
    [{ name: 'README.md', text: 'not a tool' }],
    [{ name: 'SKILL.md', text: '---\nname: ../escape\n---\nBad' }],
    [{ name: 'mcp-registry/bad.json', text: 'not json' }],
  ])('rejects unsafe or invalid archives without filesystem changes: %j', async (...entries) => {
    const e = await fixture();
    const before = await treeSnapshot(e.root);
    await expect(e.atm.importToolPackage({ source: upload(entries) })).rejects.toBeDefined();
    expect(await treeSnapshot(e.root)).toEqual(before);
  });

  it('rejects corrupt CRC and unsupported uploads', async () => {
    const e = await fixture();
    const bytes = zipFixture([{ name: 'SKILL.md', text: skill }]);
    bytes[38] = bytes[38]! ^ 1;
    for (const source of [
      { type: 'upload' as const, filename: 'tools.zip', base64: bytes.toString('base64') },
      { type: 'upload' as const, filename: 'tools.exe', base64: 'eA==' },
      { type: 'upload' as const, filename: 'tools.zip', base64: '!!!' },
    ]) await expect(e.atm.importToolPackage({ source })).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it('refuses symlink destinations and rolls back partially written files on disk failure', async () => {
    const e = await fixture();
    const outside = path.join(e.home, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(e.root, 'skills'));
    await expect(e.atm.importToolPackage({ source: upload() })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(path.join(e.root, 'skills'));
    const source = upload([{ name: 'SKILL.md', text: skill }, { name: 'scripts/check.sh', text: 'test' }]);
    const preview = await e.atm.importToolPackage({ source });
    const before = await treeSnapshot(e.root);
    const original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('check.sh')) throw new Error('disk full');
      return original(...args);
    });
    await expect(e.atm.importToolPackage({ source, sha256: preview.sha256 })).rejects.toThrow('disk full');
    expect(await treeSnapshot(e.root)).toEqual(before);
  });

  it('imports mcpServers and rejects literal secrets using the existing registry rules', async () => {
    const e = await fixture();
    const source = upload([{ name: '.mcp.json', text: JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'], env: { TOKEN: '${TOKEN}' } } } }) }]);
    const preview = await e.atm.importToolPackage({ source });
    await e.atm.importToolPackage({ source, sha256: preview.sha256 });
    expect(JSON.parse(await fs.readFile(path.join(e.registry, 'docs.json'), 'utf8')).env).toEqual({ TOKEN: '${TOKEN}' });
    await expect(e.atm.importToolPackage({ source: upload([{ name: 'mcp/bad.json', text: '{"command":"npx","env":{"TOKEN":"secret"}}' }]) })).rejects.toMatchObject({ code: 'INVALID_MCP_DEF' });
  });

  it('rolls back all tools if updating the marketplace fails and preserves its contents', async () => {
    const e = await fixture();
    const catalog = path.join(e.root, '.claude-plugin/marketplace.json');
    await write(catalog, '{"name":"atm-shared","plugins":[]}');
    const source = upload([{ name: 'plugins/helper/.claude-plugin/plugin.json', text: '{"name":"helper"}' }, { name: 'skills/review/SKILL.md', text: skill }]);
    const preview = await e.atm.importToolPackage({ source });
    const before = await treeSnapshot(e.root);
    const original = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => { if (String(b) === catalog) throw new Error('disk full'); return original(a, b); });
    await expect(e.atm.importToolPackage({ source, sha256: preview.sha256 })).rejects.toThrow('disk full');
    expect(await treeSnapshot(e.root)).toEqual(before);
  });
});
