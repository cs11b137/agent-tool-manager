import path from 'node:path';
import type { ToolKind, ToolsManifest, WriteOptions, WriteResult } from '../types.js';
import type { Ctx } from '../context.js';
import { AtmError } from '../errors.js';
import { mcpRefName, requireManifest } from '../manifest.js';
import { splitPluginId } from '../plugins/index.js';
import { contextFor } from './inspect.js';
import { planProject } from './project.js';
import { executeWrite, withFlags } from './write.js';

/** 在清单里找名字对应的工具；不传 kind 时跨类型查找，同名跨类型抛 AMBIGUOUS。 */
export function findInManifest(manifest: ToolsManifest, name: string, kind?: ToolKind): { kind: ToolKind; name: string } {
  const hits: Array<{ kind: ToolKind; name: string }> = [];
  if (!kind || kind === 'skill') for (const s of manifest.skills) if (s.name === name) hits.push({ kind: 'skill', name });
  if (!kind || kind === 'mcp') for (const m of manifest.mcp) if (mcpRefName(m) === name) hits.push({ kind: 'mcp', name });
  if (!kind || kind === 'plugin') {
    for (const p of manifest.plugins) if (p === name || splitPluginId(p).plugin === name) hits.push({ kind: 'plugin', name: p });
  }
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new AtmError('AMBIGUOUS', `"${name}" matches more than one tool`, {
      candidates: hits.map((h) => `${h.kind}:${h.name}`),
      nextCommand: `atm remove ${name} --kind ${hits[0]!.kind}`,
    });
  }
  const all = [...manifest.skills.map((s) => s.name), ...manifest.mcp.map(mcpRefName), ...manifest.plugins];
  throw new AtmError('NOT_FOUND', `"${name}" is not in .agents/tools.json${kind ? ` (kind ${kind})` : ''}`, {
    candidates: all,
    nextCommand: 'atm list',
  });
}

export function applyRemoveToManifest(manifest: ToolsManifest, hit: { kind: ToolKind; name: string }): ToolsManifest {
  return {
    ...manifest,
    skills: hit.kind === 'skill' ? manifest.skills.filter((s) => s.name !== hit.name) : [...manifest.skills],
    mcp: hit.kind === 'mcp' ? manifest.mcp.filter((m) => mcpRefName(m) !== hit.name) : [...manifest.mcp],
    plugins: hit.kind === 'plugin' ? manifest.plugins.filter((p) => p !== hit.name) : [...manifest.plugins],
  };
}

export async function removeTool(
  ctx: Ctx,
  dir: string,
  name: string,
  opts: WriteOptions & { kind?: ToolKind } = {},
): Promise<WriteResult> {
  const abs = path.resolve(dir);
  const command = `atm remove ${name}${opts.kind ? ` --kind ${opts.kind}` : ''}`;
  return executeWrite(ctx, {
    dir: abs,
    opts,
    command: withFlags(command, opts),
    activity: { message: `Removed ${opts.kind ?? 'tool'} ${name}`, ...(opts.kind ? { kind: opts.kind } : {}) },
    async plan({ cfg, planner, resolver }) {
      const files = await requireManifest(abs);
      const hit = findInManifest(files.manifest, name, opts.kind);
      const manifest = applyRemoveToManifest(files.manifest, hit);
      const lock = await planProject(planner, { cfg, dir: abs, files, manifest, opts, resolver, retryCommand: command });
      return { contextAfter: await contextFor(ctx, manifest, lock) };
    },
  });
}
