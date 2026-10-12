import { spawn, type ChildProcess } from 'node:child_process';
import type { McpDef } from '../types.js';
import type { Env } from '../context.js';
import { AtmError } from '../errors.js';
import { estimateTokens } from '../tokens.js';
import { mcpVarNames } from './registry.js';

export const MEASURE_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = '2025-06-18';

export interface ToolsListResult {
  tools: unknown[];
  contextTokens: number;
}

function expand(value: string, env: Env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => env[n] ?? '');
}

function checkVars(def: McpDef, env: Env): void {
  const missing = mcpVarNames(def).filter((n) => !env[n]);
  if (missing.length) {
    throw new AtmError('UNSUPPORTED', `cannot start ${def.name}: environment variable(s) not set: ${missing.join(', ')}`, {
      nextCommand: `export ${missing[0]}=…`,
      candidates: missing,
    });
  }
}

/** SIGTERM 整个进程组，2s 后仍在则 SIGKILL。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // 已退出
      }
    }
  };
  signalGroup('SIGTERM');
  const t = setTimeout(() => signalGroup('SIGKILL'), 2_000);
  t.unref();
}

/** stdio：spawn → initialize → notifications/initialized → tools/list（支持分页），newline-delimited JSON-RPC。 */
export function listToolsStdio(def: Extract<McpDef, { transport: 'stdio' }>, env: Env, signal?: AbortSignal, timeoutMs = MEASURE_TIMEOUT_MS): Promise<unknown[]> {
  checkVars(def, env);
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (typeof v === 'string') childEnv[k] = v;
  for (const [k, v] of Object.entries(def.env ?? {})) childEnv[k] = expand(v, env);
  const args = (def.args ?? []).map((a) => expand(a, env));

  return new Promise((resolve, reject) => {
    // detached：子进程自成进程组，超时/结束时整组杀掉（npx → node 这类会再 fork 的 server 不会留下孤儿）
    const child = spawn(expand(def.command, env), args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let settled = false;
    let buf = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map<number, (msg: Record<string, unknown>) => void>();
    const tools: unknown[] = [];

    const finish = (err: Error | null, value?: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdin.end();
      killTree(child);
      if (err) reject(err);
      else resolve(value ?? []);
    };
    const fail = (msg: string) =>
      finish(new AtmError('UNSUPPORTED', `measure ${def.name}: ${msg}${stderr ? ` — ${stderr.trim().slice(0, 300)}` : ''}`, { nextCommand: `check the ${def.name} MCP definition` }));
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    const onAbort = () => fail('aborted');
    signal?.addEventListener('abort', onAbort);

    const send = (method: string, params?: unknown, notify = false): Promise<Record<string, unknown>> => {
      const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
      if (params !== undefined) msg.params = params;
      if (notify) {
        child.stdin.write(JSON.stringify(msg) + '\n');
        return Promise.resolve({});
      }
      const id = nextId++;
      msg.id = id;
      return new Promise((res) => {
        pending.set(id, res);
        child.stdin.write(JSON.stringify(msg) + '\n');
      });
    };

    child.on('error', (e) => fail(e.message));
    // close（而不是 exit）在 stdout 读完之后才触发，不会抢在最后一条响应之前判失败
    child.on('close', (code) => fail(`server exited (code ${code})`));
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.stdout.on('data', (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const cb = pending.get(msg.id)!;
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });

    (async () => {
      const init = await send('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'atm', version: '0.1.0' },
      });
      if (init.error) return fail(`initialize failed: ${JSON.stringify(init.error)}`);
      await send('notifications/initialized', undefined, true);
      let cursor: string | undefined;
      do {
        const res = await send('tools/list', cursor ? { cursor } : {});
        if (res.error) return fail(`tools/list failed: ${JSON.stringify(res.error)}`);
        const result = (res.result ?? {}) as { tools?: unknown[]; nextCursor?: string };
        tools.push(...(result.tools ?? []));
        cursor = result.nextCursor;
      } while (cursor && !settled);
      finish(null, tools);
    })().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
  });
}

async function readRpcResponse(res: Response, id: number): Promise<Record<string, unknown>> {
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (type.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (msg.id === id) return msg;
      } catch {
        // skip
      }
    }
    throw new Error('no JSON-RPC response in event stream');
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** http（Streamable HTTP）：尽力实现。 */
export async function listToolsHttp(def: Extract<McpDef, { transport: 'http' }>, env: Env, signal?: AbortSignal, timeoutMs = MEASURE_TIMEOUT_MS): Promise<unknown[]> {
  checkVars(def, env);
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = expand(v, env);
  const url = expand(def.url, env);
  let id = 0;
  const call = async (method: string, params: unknown, notify = false) => {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (!notify) body.id = ++id;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: sig });
    const session = res.headers.get('mcp-session-id');
    if (session) headers['mcp-session-id'] = session;
    if (!res.ok && !(notify && res.status === 202)) throw new Error(`${method}: HTTP ${res.status}`);
    if (notify) return {};
    return readRpcResponse(res, id);
  };
  try {
    const init = await call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'atm', version: '0.1.0' } });
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    headers['mcp-protocol-version'] = PROTOCOL_VERSION;
    await call('notifications/initialized', {}, true);
    const tools: unknown[] = [];
    let cursor: string | undefined;
    do {
      const res = await call('tools/list', cursor ? { cursor } : {});
      if (res.error) throw new Error(`tools/list failed: ${JSON.stringify(res.error)}`);
      const result = (res.result ?? {}) as { tools?: unknown[]; nextCursor?: string };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  } catch (e) {
    if (e instanceof AtmError) throw e;
    throw new AtmError('UNSUPPORTED', `measure ${def.name}: ${(e as Error).message}`, { nextCommand: `check the ${def.name} MCP definition` });
  }
}

export async function listTools(def: McpDef, env: Env, signal?: AbortSignal, timeoutMs?: number): Promise<ToolsListResult> {
  const tools = def.transport === 'stdio' ? await listToolsStdio(def, env, signal, timeoutMs) : await listToolsHttp(def, env, signal, timeoutMs);
  return { tools, contextTokens: estimateTokens(JSON.stringify(tools)) };
}
