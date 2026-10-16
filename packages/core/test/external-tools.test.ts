import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAtm } from '../src/index.js';
import * as download from '../src/ops/package-download.js';
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
afterEach(() => vi.restoreAllMocks());
const repo = { full_name: 'team/example', description: 'Test repository' };

describe('external search', () => {
  it('searches skills and returns directly installable GitHub paths', async () => {
    vi.spyOn(download, 'downloadPackage').mockImplementation(async (url) => url.includes('/search/repositories') ? json({ items: [repo] }) : json({ tree: [{ path: 'skills/pdf/SKILL.md' }, { path: 'skills/other/SKILL.md' }] }));
    const result = await createAtm().searchExternalTools({ query: 'pdf', kind: 'skill' });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.source).toEqual({ type: 'github', repo: 'anthropics/skills', path: 'skills/pdf' });
    expect(result.warnings).toEqual([]);
  });
  it('maps local and external native plugin marketplace sources', async () => {
    vi.spyOn(download, 'downloadPackage').mockImplementation(async (url) => url.includes('/search/repositories') ? json({ items: [] }) : json({ plugins: [
      { name: 'review-local', source: './plugins/review' },
      { name: 'review-github', source: { source: 'github', repo: 'team/plugin', ref: 'v1' } },
      { name: 'review-subdir', source: { source: 'git-subdir', url: 'https://github.com/team/repo.git', path: 'plugin', sha: 'a'.repeat(40) } },
      { name: 'review-invalid', source: { source: 'url', url: 'file:///tmp/private' } },
    ] }));
    const result = await createAtm().searchExternalTools({ query: 'review', kind: 'plugin' });
    expect(result.items).toHaveLength(3);
    expect(result.items[2]?.source).toEqual({ type: 'github', repo: 'team/repo', ref: 'a'.repeat(40), path: 'plugin' });
  });
  it('filters inactive or unsupported MCP registry records and pins selected versions', async () => {
    vi.spyOn(download, 'downloadPackage').mockImplementation(async (url) => url.includes('/search/repositories') ? json({ items: [] }) : json({ servers: [
      { server: { name: 'io.example/docs', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }] } },
      { server: { name: 'io.example/deleted', version: '1.0.0', remotes: [{ type: 'streamable-http' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } },
      { server: { name: 'io.example/oci', version: '1', packages: [{ registryType: 'oci' }] } },
    ] }));
    const result = await createAtm().searchExternalTools({ query: 'docs', kind: 'mcp' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.source).toEqual({ type: 'url', url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.example%2Fdocs/versions/1.0.0' });
  });
  it('keeps successful results when another provider is rate-limited and reports failures', async () => {
    vi.spyOn(download, 'downloadPackage').mockImplementation(async (url) => { if (url.includes('/search/repositories')) throw new Error('HTTP 403'); return json({ tree: [{ path: 'skills/pdf/SKILL.md' }] }); });
    const result = await createAtm().searchExternalTools({ query: 'pdf', kind: 'skill' });
    expect(result.items).toHaveLength(1);
    expect(result.warnings[0]).toContain('HTTP 403');
    await expect(createAtm().searchExternalTools({ query: '', kind: 'skill' })).rejects.toThrow();
  });
});
