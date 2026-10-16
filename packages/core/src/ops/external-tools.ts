import type { Ctx } from '../context.js';
import type { ExternalToolQuery, ExternalToolSearchResult, ToolPackageSource } from '../types.js';
import { AtmError } from '../errors.js';
import { downloadPackage } from './package-download.js';
import { githubSource } from './tool-source.js';

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(record) : [];
const str = (v: unknown) => typeof v === 'string' ? v : '';
const githubRepo = 'anthropics/claude-plugins-official';
async function json(url: string, ctx: Ctx): Promise<Record<string, unknown>> {
  try { return record(JSON.parse((await downloadPackage(url, ctx.signal)).toString('utf8'))); }
  catch (e) { throw new AtmError('NOT_FOUND', `搜索来源暂不可用：${(e as Error).message}`); }
}
function pluginSource(value: unknown): ToolPackageSource | undefined {
  if (typeof value === 'string' && value.startsWith('./')) return { type: 'github', repo: githubRepo, path: value.slice(2) };
  const src = record(value);
  if (src.source === 'github' && typeof src.repo === 'string') return { type: 'github', ...githubSource(src.repo, str(src.sha) || str(src.ref) || undefined, str(src.path) || undefined) };
  if (['url', 'git-subdir'].includes(str(src.source)) && typeof src.url === 'string' && src.url.startsWith('https://github.com/')) return { type: 'github', ...githubSource(src.url, str(src.sha) || str(src.ref) || undefined, str(src.path) || undefined) };
  return undefined;
}

export async function searchExternalTools(ctx: Ctx, input: ExternalToolQuery): Promise<ExternalToolSearchResult> {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  if (query.length < 2 || query.length > 120 || !['skill', 'mcp', 'plugin'].includes(input.kind)) throw new AtmError('INVALID_MANIFEST', '请输入 2–120 个字符并选择工具类型');
  const items: ExternalToolSearchResult['items'] = [], warnings: string[] = [];
  const collect = async (provider: string, run: () => Promise<ExternalToolSearchResult['items']>) => {
    try { items.push(...await run()); } catch (e) { warnings.push(`${provider}：${(e as Error).message}`); }
  };
  const runs: Promise<void>[] = [];
  if (input.kind === 'mcp') runs.push(collect('MCP Registry', async () => {
    const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(query)}&version=latest&limit=10`;
    const result = await json(url, ctx);
    return list(result.servers).flatMap((entry) => {
      const server = record(entry.server), name = str(server.name), version = str(server.version);
      const meta = record(record(entry._meta)['io.modelcontextprotocol.registry/official']);
      if (!name || !version || (meta.status && meta.status !== 'active')) return [];
      const supported = list(server.remotes).some((r) => r.type === 'streamable-http') || list(server.packages).some((p) => ['npm', 'pypi'].includes(str(p.registryType)) && record(p.transport).type === 'stdio');
      if (!supported) return [];
      const url = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
      return [{ id: `mcp:${name}`, name: str(server.title) || name, description: str(server.description), provider: 'MCP Registry', url, source: { type: 'url' as const, url } }];
    });
  }));
  if (input.kind === 'plugin') runs.push(collect('Claude Plugin Marketplace', async () => {
    const result = await json(`https://raw.githubusercontent.com/${githubRepo}/HEAD/.claude-plugin/marketplace.json`, ctx);
    return list(result.plugins).filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(query.toLowerCase())).flatMap((p) => {
      let source: ToolPackageSource | undefined;
      try { source = pluginSource(p.source); } catch { return []; }
      if (!source) return [];
      return [{ id: `plugin:${p.name}`, name: str(p.name), description: str(p.description), provider: 'Claude Plugin Marketplace', url: `https://github.com/${githubRepo}`, source }];
    }).slice(0, 10);
  }));
  if (input.kind === 'skill') runs.push(collect('Agent Skills', async () => {
    const result = await json('https://api.github.com/repos/anthropics/skills/git/trees/HEAD?recursive=1', ctx);
    return list(result.tree).filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(str(f.path)) && str(f.path).toLowerCase().includes(query.toLowerCase())).slice(0, 10).map((f) => {
      const subpath = str(f.path).slice(0, -'/SKILL.md'.length);
      const name = subpath.split('/').at(-1)!;
      return { id: `skill:${name}`, name, description: subpath, provider: 'Agent Skills', url: `https://github.com/anthropics/skills/tree/HEAD/${subpath}`, source: { type: 'github' as const, repo: 'anthropics/skills', path: subpath } };
    });
  }));
  runs.push(collect('GitHub', async () => {
    const suffix = { skill: 'skill', mcp: 'mcp', plugin: 'claude plugin' }[input.kind];
    const result = await json(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${query} ${suffix}`)}&sort=stars&per_page=5`, ctx);
    return list(result.items).filter((repo) => typeof repo.full_name === 'string').map((repo) => ({ id: `github:${repo.full_name}`, name: str(repo.full_name), description: str(repo.description), provider: 'GitHub', url: `https://github.com/${repo.full_name}`, source: { type: 'github' as const, repo: str(repo.full_name) } }));
  }));
  await Promise.all(runs);
  // Curated/official tool entries precede generic repository results regardless of response order.
  items.sort((a, b) => Number(a.provider === 'GitHub') - Number(b.provider === 'GitHub'));
  return { items, warnings };
}
