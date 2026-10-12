import type { AddSpec, BatchOp, BatchResult, WriteOptions } from '../types.js';
import type { Ctx } from '../context.js';
import { errorMessage } from '../errors.js';
import { addTool } from './add.js';
import { removeTool } from './remove.js';

function isAddSpec(spec: BatchOp['spec']): spec is AddSpec {
  if (spec.kind === 'skill') return typeof (spec as { repo?: unknown }).repo === 'string';
  return true;
}

/** 逐项执行，单项失败不影响其他。 */
export async function runBatch(
  ctx: Ctx,
  ops: BatchOp[],
  resolveProject: (idOrDir: string) => Promise<string>,
  opts: WriteOptions = {},
): Promise<BatchResult> {
  const results: BatchResult['results'] = [];
  for (const op of ops) {
    try {
      const dir = await resolveProject(op.projectId);
      if (op.action === 'add') {
        if (!isAddSpec(op.spec)) throw new Error(`add skill ${op.spec.name} needs a repo`);
        results.push({ projectId: op.projectId, result: await addTool(ctx, dir, op.spec, opts) });
      } else {
        results.push({ projectId: op.projectId, result: await removeTool(ctx, dir, op.spec.name, { ...opts, kind: op.spec.kind }) });
      }
    } catch (e) {
      results.push({ projectId: op.projectId, result: { error: errorMessage(e) } });
    }
  }
  return { applied: !opts.dryRun && results.some((r) => !('error' in r.result)), results };
}
