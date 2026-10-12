import path from 'node:path';
import type { MeasureResult } from '../types.js';
import type { Ctx } from '../context.js';
import { loadConfig } from '../config.js';
import { AtmError } from '../errors.js';
import { atomicWrite } from '../fs/atomic.js';
import { withLock } from '../fs/lock.js';
import { mcpRefName, paths, requireManifest, serializeLock } from '../manifest.js';
import { listTools } from '../mcp/measure.js';
import { hashMcpDef, loadDefs, requireDef } from '../mcp/registry.js';
import { notifyWrite } from './write.js';

/** 启动 MCP server，tools/list，统计 schema token，写回 lock。失败时 lock 不变。 */
export async function measureMcp(ctx: Ctx, dir: string, name: string, timeoutMs?: number): Promise<MeasureResult> {
  const abs = path.resolve(dir);
  const cfg = await loadConfig(ctx);
  const files = await requireManifest(abs);
  if (!files.manifest.mcp.some((m) => mcpRefName(m) === name)) {
    throw new AtmError('NOT_FOUND', `MCP ${name} is not in .agents/tools.json`, { nextCommand: `atm add mcp ${name}` });
  }
  const { def } = requireDef(await loadDefs(cfg.mcpRegistry, abs), name);
  const { tools, contextTokens } = await listTools(def, ctx.env, ctx.signal, timeoutMs);
  const hash = hashMcpDef(def);
  await withLock(paths.writeLock(abs), async () => {
    const fresh = await requireManifest(abs);
    const lock = fresh.lock;
    lock.mcp[name] = { hash, contextTokens };
    const text = serializeLock(lock);
    if (text !== fresh.lockText) await atomicWrite(paths.lock(abs), text);
  });
  notifyWrite(
    ctx,
    abs,
    { applied: true, files: [{ path: paths.lock(abs), relPath: '.agents/tools.lock.json', type: 'file', before: null, after: null, diff: '', additions: 0, deletions: 0 }], warnings: [] },
    { message: `Measured MCP ${name}: ${tools.length} tools ≈ ${contextTokens} tokens`, kind: 'mcp' },
  );
  return { name, contextTokens, toolCount: tools.length };
}
