import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAtm } from '../src/index.js';
import { mkTmp, skillMd, write, writeInstalledPlugins } from './helpers.js';

describe('empty first-run library', () => {
  it('does not import native plugins or global skills before or after initializing empty storage', async () => {
    const home = await mkTmp();
    const atm = createAtm({ home });
    await writeInstalledPlugins(home, { 'existing@market': { files: { 'skills/native/SKILL.md': skillMd('native', 'Existing native tool') } } });
    await write(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'existing@market': true } }));
    await write(path.join(home, '.claude/skills/personal/SKILL.md'), skillMd('personal', 'Not managed by atm'));
    const nativeBefore = await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8');
    expect(await atm.library()).toEqual([]);
    expect((await atm.search('existing')).items).toEqual([]);
    expect(await atm.projects()).toEqual([]);
    expect(await atm.repos()).toEqual([]);
    await expect(fs.stat(path.join(home, '.config/atm/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(home, '.agent-tools'))).rejects.toMatchObject({ code: 'ENOENT' });

    await atm.initSharedDirectory({ root: '~/.agent-tools', mcpRegistry: '~/.agent-tools/mcp-registry' });
    expect(await atm.library()).toEqual([]);
    expect(await atm.repos()).toEqual([]);
    const available = await atm.library({ includeInstalledPlugins: true });
    expect(available.map((item) => item.name)).toEqual(['existing@market']);
    expect((await atm.search('existing', { includeInstalledPlugins: true })).items).toEqual(available);
    expect(await atm.library()).toEqual([]); // Discovery alone does not import anything.

    const project = path.join(home, 'project');
    await fs.mkdir(project);
    await atm.init(project);
    expect(await atm.library()).toEqual([]);
    await atm.add(project, { kind: 'plugin', name: 'existing@market' });
    expect(await atm.library()).toEqual([expect.objectContaining({ name: 'existing@market', usedBy: [atm.projectId(project)] })]);
    await atm.remove(project, 'existing@market', { kind: 'plugin' });
    expect(await atm.library()).toEqual([]);
    expect(await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8')).toBe(nativeBefore);
  });

  it('shows explicitly saved MCP tools in an otherwise empty library', async () => {
    const home = await mkTmp();
    const atm = createAtm({ home });
    await atm.initSharedDirectory({ root: '~/.agent-tools', mcpRegistry: '~/.agent-tools/mcp-registry' });
    await atm.saveMcpDef({ name: 'chosen', transport: 'http', url: 'https://example.invalid/mcp' }, 'registry');
    expect((await atm.library()).map((item) => item.name)).toEqual(['chosen']);
  });
});
