import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Restart the complete dev stack so frontend and backend never use different revisions. */
export function watchDev({ paths, command, args, cwd, env = process.env, stdio = 'inherit' }) {
  // Keep browser authentication valid across automatic restarts, without persisting it to disk.
  const sessionEnv = { ...env, ATM_DEV_TOKEN: randomBytes(32).toString('base64url') };
  let child, timer, restarting, dirty = false, stopped = false;
  const launch = () => {
    child = spawn(command, args, { cwd, env: sessionEnv, stdio });
    child.on('error', (error) => console.error('Development service failed:', error.message));
  };
  const stopChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  };
  const restart = () => {
    dirty = true;
    if (restarting) return;
    restarting = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        await stopChild();
        if (!stopped) launch();
      }
    })().finally(() => { restarting = undefined; });
  };
  const watchers = paths.map((dir) => watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(restart, 200);
  }));
  launch();
  return {
    async close() {
      stopped = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      await restarting;
      await stopChild();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runner = watchDev({
    paths: ['../../core/src', '../../server/src', '.'].map((dir) => path.resolve(here, dir)),
    command: process.execPath, args: [path.join(here, 'dev.mjs')], cwd: path.resolve(here, '..'),
  });
  process.once('SIGINT', () => void runner.close());
  process.once('SIGTERM', () => void runner.close());
}
