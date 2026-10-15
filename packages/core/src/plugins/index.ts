import path from 'node:path';
import type { PluginContents } from '../types.js';
import type { Ctx } from '../context.js';
import { exists, listDir, readJson } from '../fs/walk.js';
import { loadConfig } from '../config.js';
import { SHARED_MARKETPLACE } from '../ops/shared-repository.js';
import { isToolName } from '../manifest.js';
import { scanSkills } from '../skills/discover.js';

export interface InstalledPlugin {
  name: string;
  marketplace: string;
  scope?: string;
  installPath?: string;
  version?: string;
  sharedDirectory?: string;
  nativeInstalled?: boolean;
}

export interface PluginIndex {
  installed: Map<string, InstalledPlugin>;
  /** `~/.claude/settings.json` enabledPlugins 中为 true 的插件 */
  globallyEnabled: Set<string>;
  contents(name: string): Promise<PluginContents | undefined>;
  /**
   * 插件常驻上下文 = 内含 Skill 之和 + 内含 MCP 中已测量的部分（`measured` 按 MCP 名给出测量值，通常来自项目 lock）。
   * 未安装为 null。
   */
  contextTokens(name: string, measured?: MeasuredMcp): Promise<number | null>;
  /** 插件内含、但没有测量值的 MCP 数量（项目级 `unmeasured` 要加上它） */
  unmeasuredMcp(name: string, measured?: MeasuredMcp): Promise<number>;
}

/** MCP 名 → 测量得到的 token 数 */
export type MeasuredMcp = Record<string, { contextTokens?: number } | undefined>;

export function pluginPaths(ctx: Ctx) {
  return {
    installed: path.join(ctx.home, '.claude', 'plugins', 'installed_plugins.json'),
    settings: path.join(ctx.home, '.claude', 'settings.json'),
    globalSkills: path.join(ctx.home, '.claude', 'skills'),
  };
}

export function splitPluginId(id: string): { plugin: string; marketplace: string } {
  const at = id.lastIndexOf('@');
  return at > 0 ? { plugin: id.slice(0, at), marketplace: id.slice(at + 1) } : { plugin: id, marketplace: '' };
}

async function safeJson(p: string): Promise<unknown> {
  try {
    return await readJson(p);
  } catch {
    return null;
  }
}

export async function readPluginContents(installPath: string): Promise<PluginContents> {
  const skills = (await scanSkills(path.join(installPath, 'skills'))).map((s) => {
    const o: PluginContents['skills'][number] = { name: s.name, contextTokens: s.contextTokens };
    if (s.description) o.description = s.description;
    return o;
  });
  const mcpJson = (await safeJson(path.join(installPath, '.mcp.json'))) as { mcpServers?: Record<string, unknown> } | null;
  let mcp = Object.keys(mcpJson?.mcpServers ?? {});
  if (!mcp.length) {
    const manifest = (await safeJson(path.join(installPath, '.claude-plugin', 'plugin.json'))) as { mcpServers?: unknown } | null;
    if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') mcp = Object.keys(manifest.mcpServers);
  }
  const md = async (sub: string) =>
    (await listDir(path.join(installPath, sub))).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  return {
    skills,
    mcp: mcp.sort(),
    commands: await md('commands'),
    agents: await md('agents'),
    hooks: await exists(path.join(installPath, 'hooks')),
  };
}

/** 读 `installed_plugins.json`（version 2：`plugins[name] = [{ scope, installPath, version }]`）与全局 enabledPlugins。 */
export async function loadPluginIndex(ctx: Ctx): Promise<PluginIndex> {
  const p = pluginPaths(ctx);
  const installed = new Map<string, InstalledPlugin>();
  const raw = (await safeJson(p.installed)) as { plugins?: Record<string, unknown> } | null;
  for (const [name, v] of Object.entries(raw?.plugins ?? {})) {
    const entries = Array.isArray(v) ? v : [v];
    const first = entries.find((e) => e && typeof e === 'object') as Record<string, unknown> | undefined;
    const item: InstalledPlugin = { name, marketplace: splitPluginId(name).marketplace };
    if (first) {
      if (typeof first.scope === 'string') item.scope = first.scope;
      if (typeof first.installPath === 'string') item.installPath = first.installPath.startsWith('~/') ? path.join(ctx.home, first.installPath.slice(2)) : first.installPath;
      if (typeof first.version === 'string') item.version = first.version;
    }
    installed.set(name, item);
  }
  const cfg = await loadConfig(ctx);
  if (cfg.sharedRepository) {
    const catalog = await safeJson(path.join(cfg.root, '.claude-plugin', 'marketplace.json')) as { name?: string; plugins?: Array<{ name?: string; source?: string }> } | null;
    if (catalog?.name === SHARED_MARKETPLACE && Array.isArray(catalog.plugins)) for (const entry of catalog.plugins) {
      if (!entry.name || !isToolName(entry.name) || entry.source !== `./plugins/${entry.name}`) continue;
      const name = `${entry.name}@${SHARED_MARKETPLACE}`;
      const installPath = path.join(cfg.root, 'plugins', entry.name);
      if (!(await exists(path.join(installPath, '.claude-plugin', 'plugin.json')))) continue;
      installed.set(name, { name, marketplace: SHARED_MARKETPLACE, installPath, sharedDirectory: cfg.root, nativeInstalled: installed.has(name), version: '0.1.0' });
    }
  }
  const settings = (await safeJson(p.settings)) as { enabledPlugins?: Record<string, unknown> } | null;
  const globallyEnabled = new Set(
    Object.entries(settings?.enabledPlugins ?? {})
      .filter(([, on]) => on === true)
      .map(([n]) => n),
  );
  const cache = new Map<string, Promise<PluginContents | undefined>>();
  const contents = (name: string): Promise<PluginContents | undefined> => {
    let c = cache.get(name);
    if (!c) {
      const ip = installed.get(name)?.installPath;
      c = ip ? readPluginContents(ip) : Promise.resolve(undefined);
      cache.set(name, c);
    }
    return c;
  };
  return {
    installed,
    globallyEnabled,
    contents,
    async contextTokens(name, measured) {
      const c = await contents(name);
      if (!c) return null;
      const skills = c.skills.reduce((a, s) => a + s.contextTokens, 0);
      const mcp = c.mcp.reduce((a, m) => a + (measured?.[m]?.contextTokens ?? 0), 0);
      return skills + mcp;
    },
    async unmeasuredMcp(name, measured) {
      const c = await contents(name);
      return c ? c.mcp.filter((m) => measured?.[m]?.contextTokens === undefined).length : 0;
    },
  };
}

/** `~/.claude/skills` 下的全局 Skill 名。 */
export async function globalSkillNames(ctx: Ctx): Promise<string[]> {
  return (await listDir(pluginPaths(ctx).globalSkills)).filter((n) => !n.startsWith('.'));
}

