import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ActivityEntry, AtmEvent } from './types.js';

export type Env = Record<string, string | undefined>;

export interface CreateAtmOptions {
  /** 覆盖 os.homedir()，测试用 */
  home?: string;
  /** 覆盖 process.env，测试用 */
  env?: Env;
  /** 覆盖 ~/.config/atm/config.json */
  configPath?: string;
  onEvent?: (e: AtmEvent) => void;
  signal?: AbortSignal;
}

/** 每个 Atm 实例共享的运行时上下文。所有路径都从 `home` 派生。 */
export interface Ctx {
  home: string;
  env: Env;
  configPath: string;
  configDir: string;
  cacheDir: string;
  signal?: AbortSignal;
  emit(e: AtmEvent): void;
  activity(entry: Omit<ActivityEntry, 'at'>): void;
}

export function createCtx(opts: CreateAtmOptions = {}): Ctx {
  const home = path.resolve(opts.home ?? os.homedir());
  const configPath = opts.configPath ? path.resolve(opts.configPath) : path.join(home, '.config', 'atm', 'config.json');
  const configDir = path.dirname(configPath);
  const onEvent = opts.onEvent;
  const emit = (e: AtmEvent): void => {
    if (!onEvent) return;
    try {
      onEvent(e);
    } catch {
      // 事件回调异常不影响主流程
    }
  };
  const ctx: Ctx = {
    home,
    env: opts.env ?? process.env,
    configPath,
    configDir,
    cacheDir: path.join(configDir, 'cache'),
    emit,
    activity: (entry) => emit({ type: 'activity', entry: { at: new Date().toISOString(), ...entry } }),
  };
  if (opts.signal) ctx.signal = opts.signal;
  return ctx;
}

/** 展开 `~` / `~/…` 为 home 下的绝对路径；其余相对路径相对 cwd 解析。 */
export function expandHome(home: string, p: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return path.resolve(p);
}

/** home 下的路径压缩成 `~/…`。 */
export function compactHome(home: string, p: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return '~/' + p.slice(home.length + 1);
  return p;
}

/** FileChange.relPath：项目内用相对路径，home 下用 `~/…`，否则绝对路径。 */
export function displayPath(home: string, base: string | null, p: string): string {
  if (base && (p === base || p.startsWith(base + path.sep))) return path.relative(base, p) || '.';
  return compactHome(home, p);
}

export function projectId(p: string): string {
  return createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 12);
}

export function checkAbort(ctx: Ctx): void {
  if (ctx.signal?.aborted) {
    throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted');
  }
}
