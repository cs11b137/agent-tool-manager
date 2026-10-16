import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setup, write } from './helpers.js';
import { zipFixture } from './zip-fixture.js';
import * as download from '../src/ops/package-download.js';
import { githubSource } from '../src/ops/tool-source.js';
import { packageMcpDefinition, registryMcpDefinition } from '../src/ops/native-mcp.js';
import type { ToolPackageSource } from '../src/types.js';

const skill = '---\nname: native-review\ndescription: Review\n---\nReview code.';
const upload = (filename: string, content: string): ToolPackageSource => ({ type: 'upload', filename, base64: Buffer.from(content).toString('base64') });
async function fixture() { const e = await setup(); await e.atm.initSharedRepository({ root: e.root, mcpRegistry: e.registry }); return e; }
afterEach(() => vi.restoreAllMocks());

describe('native installation sources', () => {
  it('installs raw SKILL.md, MCP JSON, plugin.json, and .skill packages without requiring ZIP filenames', async () => {
    const e = await fixture();
    for (const source of [upload('SKILL.md', skill), upload('mcp.json', '{"mcpServers":{"native-docs":{"url":"https://example.com/mcp"}}}'), upload('plugin.json', '{"name":"native-plugin","mcpServers":{"docs":{"url":"https://example.com/mcp"}}}'), { type: 'upload' as const, filename: 'second.skill', base64: zipFixture([{ name: 'SKILL.md', text: skill.replace('native-review', 'second') }]).toString('base64') }]) {
      const preview = await e.atm.importToolPackage({ source });
      await e.atm.importToolPackage({ source, sha256: preview.sha256 });
    }
    expect((await e.atm.library()).map((t) => t.name)).toEqual(expect.arrayContaining(['native-review', 'native-docs', 'native-plugin@atm-shared', 'second']));
  });
  it('imports complete directories, preserves resources and installs only selected tools', async () => {
    const e = await fixture(), dir = path.join(e.home, 'original');
    await write(path.join(dir, 'review/SKILL.md'), skill);
    await write(path.join(dir, 'review/assets/template.txt'), 'asset');
    await write(path.join(dir, 'second/SKILL.md'), skill.replace('native-review', 'second'));
    const source = { type: 'directory' as const, path: dir };
    const preview = await e.atm.importToolPackage({ source });
    expect(preview.tools).toHaveLength(2);
    await e.atm.importToolPackage({ source, sha256: preview.sha256, selection: ['skill:native-review'] });
    expect(await fs.readFile(path.join(e.root, 'skills/native-review/assets/template.txt'), 'utf8')).toBe('asset');
    await expect(fs.stat(path.join(e.root, 'skills/second'))).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await e.atm.importToolPackage({ source });
    expect(next.tools.find((t) => t.name === 'native-review')?.conflict).toBe(true);
    await e.atm.importToolPackage({ source, sha256: next.sha256, selection: ['skill:second'] });
    await expect(e.atm.importToolPackage({ source, sha256: next.sha256, selection: ['skill:unknown'] })).rejects.toThrow('有效');
  });
  it('rejects directory links and detects changes after preview', async () => {
    const e = await fixture(), dir = path.join(e.home, 'source');
    await write(path.join(dir, 'SKILL.md'), skill);
    const source = { type: 'directory' as const, path: dir }, preview = await e.atm.importToolPackage({ source });
    await write(path.join(dir, 'SKILL.md'), skill + ' changed');
    await expect(e.atm.importToolPackage({ source, sha256: preview.sha256 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await fs.symlink(e.registry, path.join(dir, 'linked'));
    await expect(e.atm.importToolPackage({ source })).rejects.toThrow('软链');
  });
  it('pulls GitHub snapshots and preserves a selected skill directory including scripts', async () => {
    const e = await fixture();
    const request = vi.spyOn(download, 'downloadPackage').mockResolvedValue(zipFixture([
      { name: 'repo-main/skills/review/SKILL.md', text: skill },
      { name: 'repo-main/skills/review/scripts/check.sh', text: '#!/bin/sh', mode: 0o100755 },
      { name: 'repo-main/skills/other/SKILL.md', text: skill.replace('native-review', 'other') },
    ]));
    const source = { type: 'github' as const, repo: 'https://github.com/team/repo/tree/main/skills/review' };
    const preview = await e.atm.importToolPackage({ source });
    expect(preview.tools).toHaveLength(1);
    expect(preview.tools[0]?.files).toBe(2);
    expect(request).toHaveBeenCalledWith('https://codeload.github.com/team/repo/zip/main', undefined);
    await e.atm.importToolPackage({ source, sha256: preview.sha256 });
    expect(await fs.readFile(path.join(e.root, 'skills/native-review/scripts/check.sh'), 'utf8')).toContain('#!/bin/sh');
  });
  it('supports direct native URLs and registry envelopes', async () => {
    const e = await fixture(), request = vi.spyOn(download, 'downloadPackage');
    request.mockResolvedValueOnce(Buffer.from(skill));
    expect((await e.atm.importToolPackage({ source: { type: 'url', url: 'https://example.com/SKILL.md' } })).tools[0]?.kind).toBe('skill');
    request.mockResolvedValueOnce(Buffer.from(JSON.stringify({ server: { name: 'io.example/docs', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }] } })));
    const result = await e.atm.importToolPackage({ source: { type: 'url', url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fdocs/versions/1.0' } });
    expect(result.tools[0]?.name).toBe('io.example-docs');
  });
  it('supports npm/PyPI native specifications with honest runtime requirements', async () => {
    const e = await fixture();
    for (const spec of ['npm:@example/server@1.2.3', 'pypi:mcp-server-fetch==1.0.0']) {
      const source = { type: 'mcp' as const, spec }, preview = await e.atm.importToolPackage({ source });
      expect(preview.warnings?.join(' ')).toContain('首次启动');
      await e.atm.importToolPackage({ source, sha256: preview.sha256 });
    }
    expect(packageMcpDefinition('npm:@example/server')).toMatchObject({ name: 'example-server', command: 'npx', args: ['-y', '@example/server'] });
    expect(packageMcpDefinition('pypi:mcp-server-fetch')).toMatchObject({ command: 'uvx', args: ['mcp-server-fetch'] });
    expect(() => packageMcpDefinition('npm:--eval=bad')).toThrow();
    expect(() => packageMcpDefinition('npm:pkg;evil')).toThrow();
  });
  it('converts official MCP package metadata including arguments and environment references', () => {
    expect(registryMcpDefinition({ name: 'io.example/docs', packages: [{ registryType: 'npm', identifier: '@example/docs', version: '1.2.0', transport: { type: 'stdio' }, runtimeArguments: [{ type: 'positional', value: '-y' }], packageArguments: [{ type: 'named', name: '--dir', value: '{workspace}' }], environmentVariables: [{ name: 'API_KEY', isSecret: true }] }] })).toMatchObject({ name: 'io.example-docs', command: 'npx', args: ['-y', '@example/docs@1.2.0', '--dir', '${WORKSPACE}'], env: { API_KEY: '${API_KEY}' } });
    expect(() => registryMcpDefinition({ name: 'io.example/native', packages: [{ registryType: 'oci' }] })).toThrow();
  });
  it('validates repository paths and supports slash-containing explicit refs', () => {
    expect(githubSource('https://github.com/team/repo/tree/feature/new/skills/review', 'feature/new')).toEqual({ repo: 'team/repo', ref: 'feature/new', path: 'skills/review' });
    for (const url of ['https://evil.example/team/repo', 'https://github.com/team/repo/tree/main/../escape', '--upload-pack=evil', 'team/../tree/main']) expect(() => githubSource(url)).toThrow();
  });
});

it('keeps native MCP scripts with the installed definition and rewrites relative launch paths', async () => {
  const e = await fixture(), dir = path.join(e.home, 'mcp-source');
  await write(path.join(dir, '.mcp.json'), '{"mcpServers":{"local-server":{"command":"node","args":["./server/index.js"]}}}');
  await write(path.join(dir, 'server/index.js'), 'console.log("server");');
  const source = { type: 'directory' as const, path: dir }, preview = await e.atm.importToolPackage({ source });
  await e.atm.importToolPackage({ source, sha256: preview.sha256 });
  const definition = JSON.parse(await fs.readFile(path.join(e.registry, 'local-server.json'), 'utf8'));
  expect(definition.args).toEqual([path.join(e.root, '.mcp-packages/local-server/server/index.js')]);
  expect(await fs.readFile(definition.args[0], 'utf8')).toContain('server');
  expect((await e.atm.sharedRepository()).changes).toContain('.mcp-packages/local-server/server/index.js');
});

it('rejects incomplete plugin manifests and MCP definitions that reference missing local scripts', async () => {
  const e = await fixture();
  await expect(e.atm.importToolPackage({ source: upload('plugin.json', '{"name":"missing","commands":"./commands"}') })).rejects.toThrow('文件缺失');
  await expect(e.atm.importToolPackage({ source: upload('mcp.json', '{"name":"missing","command":"node","args":["./server.js"]}') })).rejects.toThrow('文件缺失');
});
