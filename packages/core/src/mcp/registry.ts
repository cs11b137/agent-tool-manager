import { createHash } from 'node:crypto';
import path from 'node:path';
import type { EnvVarStatus, McpDef, McpHttpDef, McpStdioDef } from '../types.js';
import type { Env } from '../context.js';
import { AtmError } from '../errors.js';
import { listDir, readText } from '../fs/walk.js';
import { paths } from '../manifest.js';

export const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const EXACT_VAR = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function bad(msg: string, file?: string): AtmError {
  return new AtmError('INVALID_MCP_DEF', file ? `${file}: ${msg}` : msg, {
    nextCommand: file ? `fix ${file}` : 'atm doctor',
  });
}

function stringRecord(v: unknown, field: string, file?: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${field} must be an object`, file);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') throw bad(`${field}.${k} must be a string`, file);
    out[k] = val;
  }
  return out;
}

/**
 * 校验 MCP 定义。`env` 的值必须完整是 `${VAR}`；`headers` 的值必须包含 `${VAR}`（允许 `Bearer ${VAR}`）。
 * 缺少 name 时用 `fallbackName`（文件名）。
 */
export function validateMcpDef(raw: unknown, file?: string, fallbackName?: string): McpDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('definition must be a JSON object', file);
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' && r.name ? r.name : fallbackName;
  if (!name || !NAME.test(name)) throw bad(`invalid name ${JSON.stringify(r.name ?? fallbackName)}`, file);
  if (r.description !== undefined && typeof r.description !== 'string') throw bad('description must be a string', file);
  const transport = r.transport ?? (typeof r.url === 'string' ? 'http' : 'stdio');
  if (transport === 'stdio') {
    if (typeof r.command !== 'string' || !r.command) throw bad('stdio definition needs a "command"', file);
    if (r.args !== undefined && (!Array.isArray(r.args) || r.args.some((a) => typeof a !== 'string'))) {
      throw bad('args must be an array of strings', file);
    }
    const env = stringRecord(r.env, 'env', file);
    for (const [k, v] of Object.entries(env ?? {})) {
      if (!EXACT_VAR.test(v)) throw bad(`env.${k} must be a \${VAR} reference, not a literal value`, file);
    }
    const def: McpStdioDef = { name, transport: 'stdio', command: r.command };
    if (typeof r.description === 'string') def.description = r.description;
    if (r.args) def.args = [...(r.args as string[])];
    if (env && Object.keys(env).length) def.env = env;
    return def;
  }
  if (transport === 'http') {
    if (typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) throw bad('http definition needs an http(s) "url"', file);
    const headers = stringRecord(r.headers, 'headers', file);
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (!new RegExp(VAR_REF.source).test(v)) throw bad(`headers.${k} must reference a \${VAR}, not a literal value`, file);
    }
    const def: McpHttpDef = { name, transport: 'http', url: r.url };
    if (typeof r.description === 'string') def.description = r.description;
    if (headers && Object.keys(headers).length) def.headers = headers;
    return def;
  }
  throw bad(`unknown transport ${JSON.stringify(transport)} (expected stdio or http)`, file);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function hashMcpDef(def: McpDef): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical(def))).digest('hex');
}

export function mcpVarNames(def: McpDef): string[] {
  const values = def.transport === 'stdio' ? [...Object.values(def.env ?? {}), ...(def.args ?? []), def.command] : [...Object.values(def.headers ?? {}), def.url];
  const names = new Set<string>();
  for (const v of values) for (const m of v.matchAll(VAR_REF)) names.add(m[1]!);
  return [...names].sort();
}

export function envVarStatus(def: McpDef, env: Env): EnvVarStatus[] {
  return mcpVarNames(def).map((name) => ({ name, set: typeof env[name] === 'string' && env[name] !== '' }));
}

export interface LoadedDef {
  def: McpDef;
  origin: 'registry' | 'project';
  file: string;
}

export interface DefLoadError {
  file: string;
  origin: 'registry' | 'project';
  error: string;
  raw?: unknown;
}

export interface DefSet {
  defs: Map<string, LoadedDef>;
  errors: DefLoadError[];
  /** 所有读到的原始 JSON（含校验失败的），供密钥扫描 */
  raw: Array<{ file: string; origin: 'registry' | 'project'; raw: unknown }>;
}

async function loadDir(dir: string, origin: 'registry' | 'project', into: DefSet): Promise<void> {
  for (const f of await listDir(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    const text = await readText(file);
    if (text === null) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      into.errors.push({ file, origin, error: `invalid JSON: ${(e as Error).message}` });
      continue;
    }
    into.raw.push({ file, origin, raw });
    try {
      const def = validateMcpDef(raw, file, path.basename(f, '.json'));
      into.defs.set(def.name, { def, origin, file });
    } catch (e) {
      into.errors.push({ file, origin, error: (e as Error).message, raw });
    }
  }
}

/** 读 registry + 项目内 `.agents/mcp/`（项目内优先）。 */
export async function loadDefs(registryDir: string, projectDir?: string): Promise<DefSet> {
  const set: DefSet = { defs: new Map(), errors: [], raw: [] };
  await loadDir(registryDir, 'registry', set);
  if (projectDir) await loadDir(paths.projectMcpDir(projectDir), 'project', set);
  return set;
}

export function requireDef(set: DefSet, name: string): LoadedDef {
  const found = set.defs.get(name);
  if (found) return found;
  const err = set.errors.find((e) => path.basename(e.file, '.json') === name);
  if (err) throw new AtmError('INVALID_MCP_DEF', err.error, { nextCommand: `fix ${err.file}` });
  throw new AtmError('NOT_FOUND', `no MCP definition named "${name}" in the registry or .agents/mcp/`, {
    candidates: [...set.defs.keys()].sort(),
    nextCommand: `create .agents/mcp/${name}.json, then atm add mcp ${name}`,
  });
}
