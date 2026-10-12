import path from 'node:path';
import type { AgentId, WriteOptions, WriteResult } from '../types.js';
import { ALL_AGENTS } from '../types.js';
import type { Ctx } from '../context.js';
import { AtmError } from '../errors.js';
import { requireManifest } from '../manifest.js';
import { contextFor } from './inspect.js';
import { planProject } from './project.js';
import { executeWrite, withFlags } from './write.js';

export async function setAgents(ctx: Ctx, dir: string, agents: AgentId[], opts: WriteOptions = {}): Promise<WriteResult> {
  const bad = agents.filter((a) => !(ALL_AGENTS as readonly string[]).includes(a));
  if (bad.length) {
    throw new AtmError('INVALID_MANIFEST', `unknown agent(s): ${bad.join(', ')}`, { candidates: [...ALL_AGENTS], nextCommand: 'atm list' });
  }
  const abs = path.resolve(dir);
  const command = `atm agents ${agents.join(',')}`;
  return executeWrite(ctx, {
    dir: abs,
    opts,
    command: withFlags(command, opts),
    activity: { message: `Set agents to ${agents.join(', ') || '(none)'}` },
    async plan({ cfg, planner, resolver }) {
      const files = await requireManifest(abs);
      const manifest = { ...files.manifest, agents: [...new Set(agents)] };
      const lock = await planProject(planner, { cfg, dir: abs, files, manifest, opts, resolver, gitignore: true, retryCommand: command });
      return { contextAfter: await contextFor(ctx, manifest, lock) };
    },
  });
}
