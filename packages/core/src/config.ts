import path from 'node:path';
import fs from 'node:fs/promises';
import type { AgentId, GlobalConfig, SharedDirectoryInput } from './types.js';
import { ALL_AGENTS } from './types.js';
import { compactHome, expandHome, type Ctx } from './context.js';
import { AtmError } from './errors.js';
import { atomicWrite } from './fs/atomic.js';
import { readText } from './fs/walk.js';
import { withLock } from './fs/lock.js';

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
  return normalizeConfig(ctx, await readRaw(ctx));
}

function normalizeConfig(ctx: Ctx, raw: RawConfig): GlobalConfig {
  const root = expandHome(ctx.home, typeof raw.root === 'string' && raw.root ? raw.root : '~/.agent-tools');
  const mcpRegistry =
    typeof raw.mcpRegistry === 'string' && raw.mcpRegistry ? expandHome(ctx.home, raw.mcpRegistry) : path.join(root, 'mcp-registry');
  const projects: string[] = [];
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    if (typeof p !== 'string') continue;
    const abs = expandHome(ctx.home, p);
    if (!projects.includes(abs)) projects.push(abs);
  }
  return { root, mcpRegistry, defaultAgents: normalizeAgents(raw.defaultAgents), projects, ...(raw.sharedRepository === true ? { sharedRepository: true } : {}) };
}

/** 合并 patch 并写回；路径字段在 home 下时以 `~/…` 存储。 */
export async function saveConfig(ctx: Ctx, patch: Partial<GlobalConfig>): Promise<GlobalConfig> {
  const raw = await readRaw(ctx);
  const next: RawConfig = { ...raw };
  if (patch.root !== undefined && expandHome(ctx.home, patch.root) !== (await loadConfig(ctx)).root) delete next.sharedRepository;
  if (patch.sharedRepository !== undefined) next.sharedRepository = patch.sharedRepository;
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
  return normalizeConfig(ctx, next);
}

export async function addProjectToRegistry(ctx: Ctx, dir: string): Promise<boolean> {
  const cfg = await loadConfig(ctx);
  const abs = path.resolve(dir);
  if (cfg.projects.includes(abs)) return false;
  await saveConfig(ctx, { projects: [...cfg.projects, abs] });
  return true;
}

/** Create only missing directories; never move or replace existing content. */
export async function initSharedDirectory(ctx: Ctx, input: SharedDirectoryInput, prepare?: (root: string) => Promise<() => Promise<void>>, defaultAgents?: AgentId[]): Promise<GlobalConfig> {
  const normalize = (value: string, label: string): string => {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!clean || clean.includes('\0') || !(path.isAbsolute(clean) || clean === '~' || clean.startsWith('~/'))) {
      throw new AtmError('INVALID_MANIFEST', `${label}：请输入绝对路径或 ~/ 开头的路径`, {
        nextCommand: '修改目录路径后重试',
      });
    }
    return expandHome(ctx.home, clean);
  };
  const root = normalize(input.root, '共享根目录');
  const mcpRegistry = normalize(input.mcpRegistry, 'MCP registry');
  return withLock(path.join(ctx.configDir, '.lock'), async () => {
    // Reject unreadable/invalid configuration before creating tool directories.
    await loadConfig(ctx);
    const created: string[] = [];
    let rollback: (() => Promise<void>) | undefined;
    const ensureDir = async (dir: string): Promise<void> => {
      const parent = path.dirname(dir);
      if (parent !== dir) await ensureDir(parent);
      const st = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (st) {
        if (st.isDirectory()) return;
        if (st.isSymbolicLink()) {
          const target = await fs.stat(dir).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
            throw error;
          });
          if (target?.isDirectory()) return;
        }
        throw new AtmError('CONFLICT', `目录不可用：${dir}（文件占位或无效软链）`, {
          nextCommand: '选择其他目录，或修复该路径后重试',
        });
      }
      try {
        await fs.mkdir(dir);
        created.push(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return ensureDir(dir);
        throw error;
      }
    };
    try {
      await ensureDir(root);
      await ensureDir(mcpRegistry);
      await fs.access(root, fs.constants.W_OK | fs.constants.X_OK);
      await fs.access(mcpRegistry, fs.constants.W_OK | fs.constants.X_OK);
      rollback = await prepare?.(root);
      const cfg = await saveConfig(ctx, { root, mcpRegistry, ...(defaultAgents ? { defaultAgents } : {}), ...(prepare ? { sharedRepository: true } : {}) });
      ctx.emit({ type: 'library.changed' });
      return cfg;
    } catch (error) {
      const failures: string[] = [];
      if (rollback) await rollback().catch(() => failures.push(root));
      for (const dir of created.reverse()) {
        try {
          await fs.rmdir(dir);
        } catch (cleanupError) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((cleanupError as NodeJS.ErrnoException).code ?? '')) failures.push(dir);
        }
      }
      if (error instanceof Error) {
        if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          error.message += '；请检查目录写入权限或选择其他目录后重试';
        }
        if (failures.length) error.message += `；未能清理新建空目录：${failures.join(', ')}`;
      }
      throw error;
    }
  });
}
