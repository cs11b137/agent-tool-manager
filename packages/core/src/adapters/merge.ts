import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { AtmError } from '../errors.js';

export type Indent = string | number;

/** 检测 JSON 缩进：取第一个以空白开头的行（通常是第二行），默认 2 空格。 */
export function detectIndent(text: string | null): Indent {
  if (!text) return 2;
  const lines = text.split('\n').slice(1, 3);
  for (const line of lines) {
    const m = /^([ \t]+)\S/.exec(line);
    if (m) return m[1]!.startsWith('\t') ? '\t' : m[1]!.length;
  }
  return 2;
}

export function parseDoc(text: string | null, format: 'json' | 'toml', file: string): Record<string, unknown> {
  if (text === null || text.trim() === '') return {};
  try {
    const doc = format === 'json' ? (JSON.parse(text) as unknown) : (parseToml(text) as unknown);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('top level must be an object');
    return doc as Record<string, unknown>;
  } catch (e) {
    throw new AtmError('CONFLICT', `cannot parse ${file}: ${(e as Error).message}`, { nextCommand: `fix ${file} by hand, then re-run` });
  }
}

export function stringifyDoc(doc: Record<string, unknown>, format: 'json' | 'toml', indent: Indent): string {
  if (format === 'json') return JSON.stringify(doc, null, indent) + '\n';
  const s = stringifyToml(doc);
  return s.endsWith('\n') ? s : s + '\n';
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export interface MergeOptions {
  adopt?: boolean;
  /** 冲突时展示的文件名 */
  file: string;
  /** 冲突提示中「加 --adopt 重试」的命令 */
  retryCommand?: string;
}

/**
 * 合并写入算法（tech-design §6.4）：
 * - 删除 managedOld 中不再需要的条目
 * - 已有同名但不在 managedOld 中的条目 → CONFLICT（adopt 时接管）
 * - 写入 desired 条目；未受管条目原样保留
 * 返回新的表与新的 managed 列表。
 */
export function mergeEntries(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
  managedOld: string[],
  opts: MergeOptions,
): { next: Record<string, unknown>; managed: string[] } {
  const next: Record<string, unknown> = { ...current };
  for (const name of managedOld) if (!(name in desired)) delete next[name];
  for (const [name, value] of Object.entries(desired)) {
    if (Object.hasOwn(current, name) && !managedOld.includes(name) && !opts.adopt) {
      throw new AtmError('CONFLICT', `${opts.file} already has a hand-written entry "${name}"`, {
        nextCommand: opts.retryCommand ? `${opts.retryCommand} --adopt` : 're-run with --adopt to let atm manage it',
        candidates: [name],
      });
    }
    next[name] = value;
  }
  return { next, managed: Object.keys(desired).sort() };
}

export interface MergeFileInput extends MergeOptions {
  before: string | null;
  format: 'json' | 'toml';
  key: string;
  desired: Record<string, unknown>;
  managedOld: string[];
}

/** 对一个配置文件执行合并写入，返回新文本（无变化时原样返回 before）。 */
export function mergeIntoFile(input: MergeFileInput): { after: string | null; managed: string[] } {
  const { before, format, key, desired, managedOld } = input;
  const doc = parseDoc(before, format, input.file);
  const hadKey = Object.hasOwn(doc, key);
  const rawTable = doc[key];
  if (rawTable !== undefined && (rawTable === null || typeof rawTable !== 'object' || Array.isArray(rawTable))) {
    throw new AtmError('CONFLICT', `${input.file}: "${key}" is not an object`, { nextCommand: `fix ${input.file} by hand` });
  }
  const table = (rawTable ?? {}) as Record<string, unknown>;
  const { next, managed } = mergeEntries(table, desired, managedOld, input);
  if (deepEqual(table, next)) return { after: before, managed };
  if (before === null && Object.keys(next).length === 0) return { after: null, managed };
  if (hadKey || Object.keys(next).length) doc[key] = next;
  return { after: stringifyDoc(doc, format, detectIndent(before)), managed };
}

/** 把字符串中的 `${VAR}` 改写成目标 Agent 的写法。 */
export function mapVars(value: string, to: (name: string) => string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => to(name));
}

export function mapRecord(rec: Record<string, string> | undefined, to: (name: string) => string): Record<string, string> | undefined {
  if (!rec || !Object.keys(rec).length) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = mapVars(v, to);
  return out;
}
