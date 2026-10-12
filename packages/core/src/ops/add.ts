import path from 'node:path';
import type { AddSpec, McpRef, ToolsManifest, WriteOptions, WriteResult } from '../types.js';
import type { Ctx } from '../context.js';
import { AtmError } from '../errors.js';
import { mcpRefName, requireManifest } from '../manifest.js';
import { loadDefs, requireDef } from '../mcp/registry.js';
import { loadPluginIndex } from '../plugins/index.js';
import { contextFor } from './inspect.js';
import { planProject } from './project.js';
import { executeWrite, withFlags } from './write.js';

export function addCommand(spec: AddSpec): string {
  if (spec.kind === 'skill') return `atm add skill ${spec.repo} ${spec.name}${spec.rev ? ` --rev ${spec.rev}` : ''}`;
  if (spec.kind === 'mcp') return `atm add mcp ${spec.name}${spec.agents?.length ? ` --agents ${spec.agents.join(',')}` : ''}`;
  return `atm add plugin ${spec.name}`;
}

/** 在内存中把 spec 应用到清单上（纯函数）。 */
export function applyAddToManifest(manifest: ToolsManifest, spec: AddSpec): ToolsManifest {
  const next: ToolsManifest = { ...manifest, skills: [...manifest.skills], mcp: [...manifest.mcp], plugins: [...manifest.plugins] };
  if (spec.kind === 'skill') {
    const existing = next.skills.findIndex((s) => s.name === spec.name);
    if (existing >= 0 && next.skills[existing]!.repo !== spec.repo) {
      throw new AtmError('ALREADY_EXISTS', `skill ${spec.name} is already added from ${next.skills[existing]!.repo}`, {
        nextCommand: `atm remove ${spec.name} --kind skill`,
      });
    }
    const ref = spec.rev ? { repo: spec.repo, name: spec.name, rev: spec.rev } : { repo: spec.repo, name: spec.name };
    if (existing >= 0) next.skills[existing] = ref;
    else next.skills.push(ref);
  } else if (spec.kind === 'mcp') {
    const ref: string | McpRef = spec.agents?.length ? { name: spec.name, agents: [...spec.agents] } : spec.name;
    const existing = next.mcp.findIndex((m) => mcpRefName(m) === spec.name);
    if (existing >= 0) next.mcp[existing] = ref;
    else next.mcp.push(ref);
  } else if (!next.plugins.includes(spec.name)) {
    next.plugins.push(spec.name);
  }
  return next;
}

export async function addTool(ctx: Ctx, dir: string, spec: AddSpec, opts: WriteOptions = {}): Promise<WriteResult> {
  const abs = path.resolve(dir);
  const command = addCommand(spec);
  return executeWrite(ctx, {
    dir: abs,
    opts,
    command: withFlags(command, opts),
    activity: { message: `Added ${spec.kind} ${spec.name}`, kind: spec.kind },
    async plan({ cfg, planner, resolver }) {
      const files = await requireManifest(abs);
      const plugins = await loadPluginIndex(ctx);
      if (spec.kind === 'mcp') requireDef(await loadDefs(cfg.mcpRegistry, abs), spec.name);
      if (spec.kind === 'plugin' && !plugins.installed.has(spec.name)) {
        throw new AtmError('PLUGIN_NOT_INSTALLED', `plugin ${spec.name} is not installed`, {
          nextCommand: `/plugin install ${spec.name}`,
        });
      }
      const manifest = applyAddToManifest(files.manifest, spec);
      const lock = await planProject(planner, {
        cfg,
        dir: abs,
        files,
        manifest,
        opts,
        resolver,
        retryCommand: command,
        ...(spec.kind === 'skill' ? { forceResolve: new Set([spec.name]) } : {}),
      });
      return { contextAfter: await contextFor(ctx, manifest, lock, plugins) };
    },
  });
}
