import { ALL_AGENTS, type AddSpec, type AgentId, type BatchOp, type GlobalConfig, type McpDef, type MigrateSpec, type ToolKind, type WriteOptions } from '@atm/core';
import { BadRequest } from './errors.js';

type Obj = Record<string, unknown>;

const KINDS: readonly ToolKind[] = ['skill', 'mcp', 'plugin'];

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function obj(v: unknown, what = 'body'): Obj {
  if (!isObj(v)) throw new BadRequest(`${what} must be a JSON object`);
  return v;
}

export function reqStr(o: Obj, key: string, what = key): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw new BadRequest(`"${what}" must be a non-empty string`);
  return v;
}

export function optStr(o: Obj, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new BadRequest(`"${key}" must be a string`);
  return v;
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new BadRequest(`"${key}" must be a boolean`);
  return v;
}

export function strArr(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new BadRequest(`"${what}" must be an array of strings`);
  return v as string[];
}

export function agents(v: unknown, what = 'agents'): AgentId[] {
  const arr = strArr(v, what);
  for (const a of arr) if (!ALL_AGENTS.includes(a as AgentId)) throw new BadRequest(`unknown agent "${a}" (expected one of ${ALL_AGENTS.join(', ')})`);
  return arr as AgentId[];
}

export function kind(v: unknown, allowed: readonly string[] = KINDS): ToolKind {
  if (typeof v !== 'string' || !allowed.includes(v)) throw new BadRequest(`"kind" must be one of ${allowed.join(', ')}`);
  return v as ToolKind;
}

export function writeOptions(body: unknown): WriteOptions {
  if (body === undefined || body === null) return {};
  const o = obj(body);
  const out: WriteOptions = {};
  const dryRun = optBool(o, 'dryRun');
  const adopt = optBool(o, 'adopt');
  const force = optBool(o, 'force');
  if (dryRun !== undefined) out.dryRun = dryRun;
  if (adopt !== undefined) out.adopt = adopt;
  if (force !== undefined) out.force = force;
  return out;
}

export function addSpec(body: unknown, what = 'body'): AddSpec {
  const o = obj(body, what);
  const k = kind(o.kind);
  const name = reqStr(o, 'name');
  if (k === 'skill') {
    const spec: AddSpec = { kind: 'skill', repo: reqStr(o, 'repo'), name };
    const rev = optStr(o, 'rev');
    if (rev) spec.rev = rev;
    return spec;
  }
  if (k === 'mcp') {
    const spec: AddSpec = { kind: 'mcp', name };
    if (o.agents !== undefined) spec.agents = agents(o.agents);
    return spec;
  }
  return { kind: 'plugin', name };
}

export function batchOps(body: unknown): BatchOp[] {
  const o = obj(body);
  if (!Array.isArray(o.ops)) throw new BadRequest('"ops" must be an array');
  return o.ops.map((raw, i): BatchOp => {
    const op = obj(raw, `ops[${i}]`);
    const projectId = reqStr(op, 'projectId', `ops[${i}].projectId`);
    const action = op.action;
    if (action !== 'add' && action !== 'remove') throw new BadRequest(`ops[${i}].action must be "add" or "remove"`);
    if (action === 'add') return { projectId, action, spec: addSpec(op.spec, `ops[${i}].spec`) };
    const spec = obj(op.spec, `ops[${i}].spec`);
    return { projectId, action, spec: { kind: kind(spec.kind), name: reqStr(spec, 'name', `ops[${i}].spec.name`) } };
  });
}

export function migrateSpec(body: unknown): MigrateSpec {
  const o = obj(body);
  const k = kind(o.kind, ['skill', 'plugin']) as 'skill' | 'plugin';
  const removeGlobal = optBool(o, 'removeGlobal') ?? false;
  return { kind: k, name: reqStr(o, 'name'), projectIds: strArr(o.projectIds, 'projectIds'), removeGlobal };
}

export function configPatch(body: unknown): Partial<GlobalConfig> {
  const o = obj(body);
  const out: Partial<GlobalConfig> = {};
  for (const key of Object.keys(o)) {
    if (!['root', 'mcpRegistry', 'defaultAgents', 'projects'].includes(key)) throw new BadRequest(`unknown config field "${key}"`);
  }
  if (o.root !== undefined) out.root = reqStr(o, 'root');
  if (o.mcpRegistry !== undefined) out.mcpRegistry = reqStr(o, 'mcpRegistry');
  if (o.defaultAgents !== undefined) out.defaultAgents = agents(o.defaultAgents, 'defaultAgents');
  if (o.projects !== undefined) out.projects = strArr(o.projects, 'projects');
  return out;
}

/** Shape check only; core's `saveMcpDef` does the full validation (`INVALID_MCP_DEF`). */
export function mcpDef(v: unknown): McpDef {
  const o = obj(v, 'def');
  reqStr(o, 'name', 'def.name');
  if (o.transport !== 'stdio' && o.transport !== 'http') throw new BadRequest('"def.transport" must be "stdio" or "http"');
  return o as unknown as McpDef;
}
