import path from 'node:path';
import type { AgentId, GlobalConfig } from './types.js';
import { ALL_AGENTS } from './types.js';
import { compactHome, expandHome, type Ctx } from './context.js';
import { AtmError } from './errors.js';
import { atomicWrite } from './fs/atomic.js';
import { readText } from './fs/walk.js';

type RawConfig = Partial<GlobalConfig>;

async function readRaw(ctx: Ctx): Promise<RawConfig> {
  const text = await readText(ctx.configPath);
  if (text === null) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RawConfig) : {};
  } catch (e) {
    throw new AtmError('INVALID_MANIFEST', `invalid JSON in ${ctx.configPath}: ${(e as Error).message}`, {
      nextCommand: `fix or delete ${compactHome(ctx.home, ctx.configPath)}`,
    });
  }
}

function normalizeAgents(v: unknown): AgentId[] {
  if (!Array.isArray(v)) return ['claude-code'];
  const agents = v.filter((a): a is AgentId => typeof a === 'string' && (ALL_AGENTS as readonly string[]).includes(a));
  return agents.length ? agents : ['claude-code'];
}

/** 读取全局配置；路径字段全部展开成绝对路径。 */
export async function loadConfig(ctx: Ctx): Promise<GlobalConfig> {
  const raw = await readRaw(ctx);
  const root = expandHome(ctx.home, typeof raw.root === 'string' && raw.root ? raw.root : '~/GitHub');
  const mcpRegistry =
    typeof raw.mcpRegistry === 'string' && raw.mcpRegistry ? expandHome(ctx.home, raw.mcpRegistry) : path.join(root, 'mcp-registry');
  const projects: string[] = [];
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    if (typeof p !== 'string') continue;
    const abs = expandHome(ctx.home, p);
    if (!projects.includes(abs)) projects.push(abs);
  }
  return { root, mcpRegistry, defaultAgents: normalizeAgents(raw.defaultAgents), projects };
}

/** 合并 patch 并写回；路径字段在 home 下时以 `~/…` 存储。 */
export async function saveConfig(ctx: Ctx, patch: Partial<GlobalConfig>): Promise<GlobalConfig> {
  const raw = await readRaw(ctx);
  const next: RawConfig = { ...raw };
  if (patch.root !== undefined) next.root = compactHome(ctx.home, expandHome(ctx.home, patch.root));
  if (patch.mcpRegistry !== undefined) next.mcpRegistry = compactHome(ctx.home, expandHome(ctx.home, patch.mcpRegistry));
  if (patch.defaultAgents !== undefined) next.defaultAgents = normalizeAgents(patch.defaultAgents);
  if (patch.projects !== undefined) {
    const seen = new Set<string>();
    next.projects = [];
    for (const p of patch.projects) {
      const abs = expandHome(ctx.home, p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      next.projects.push(compactHome(ctx.home, abs));
    }
  }
  await atomicWrite(ctx.configPath, JSON.stringify(next, null, 2) + '\n');
  return loadConfig(ctx);
}

export async function addProjectToRegistry(ctx: Ctx, dir: string): Promise<boolean> {
  const cfg = await loadConfig(ctx);
  const abs = path.resolve(dir);
  if (cfg.projects.includes(abs)) return false;
  await saveConfig(ctx, { projects: [...cfg.projects, abs] });
  return true;
}
