import fs, { type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { AtmEvent } from './types.js';
import { projectId } from './context.js';

const IGNORE = /(^\.lock$)|(\.atm-.*\.tmp$)|(^\.DS_Store$)/;

interface WatchTarget {
  dir: string;
  filter?: (file: string) => boolean;
  event: () => AtmEvent;
}

function targetsFor(projectDir: string): WatchTarget[] {
  const pid = projectId(projectDir);
  const changed = (reason: 'manifest' | 'agent-config' | 'registry') => (): AtmEvent => ({ type: 'project.changed', projectId: pid, reason });
  return [
    { dir: path.join(projectDir, '.agents'), filter: (f) => f === 'tools.json' || f === 'tools.lock.json' || f === 'skills', event: changed('manifest') },
    { dir: path.join(projectDir, '.agents', 'skills'), event: changed('manifest') },
    { dir: path.join(projectDir, '.agents', 'mcp'), event: changed('registry') },
    { dir: projectDir, filter: (f) => f === '.mcp.json', event: changed('agent-config') },
    { dir: path.join(projectDir, '.cursor'), filter: (f) => f === 'mcp.json' || f === 'skills', event: changed('agent-config') },
    { dir: path.join(projectDir, '.codex'), filter: (f) => f === 'config.toml', event: changed('agent-config') },
    { dir: path.join(projectDir, '.claude'), filter: (f) => f === 'settings.json' || f === 'skills', event: changed('agent-config') },
  ];
}

/** fs.watch 项目的 `.agents/` 与各 Agent 配置文件、registry 目录；事件做 150ms 去抖。返回停止函数。 */
export function startWatch(projectDirs: string[], registryDir: string | null, cb: (e: AtmEvent) => void): () => void {
  const watchers: FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = false;
  const fire = (key: string, e: AtmEvent) => {
    if (stopped) return;
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (!stopped) cb(e);
      }, 150),
    );
  };
  const targets: WatchTarget[] = projectDirs.flatMap(targetsFor);
  if (registryDir) targets.push({ dir: registryDir, filter: (f) => f.endsWith('.json'), event: () => ({ type: 'library.changed' }) });
  for (const t of targets) {
    try {
      const w = fs.watch(t.dir, { persistent: false }, (_evt, file) => {
        const name = file ? file.toString() : '';
        if (name && IGNORE.test(name)) return;
        if (t.filter && name && !t.filter(name)) return;
        const e = t.event();
        fire(JSON.stringify(e), e);
      });
      w.on('error', () => undefined);
      watchers.push(w);
    } catch {
      // 目录不存在：跳过
    }
  }
  return () => {
    stopped = true;
    for (const w of watchers) w.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
