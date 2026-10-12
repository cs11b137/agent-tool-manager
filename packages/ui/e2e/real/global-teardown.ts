import fs from 'node:fs';
import { STATE_FILE, readState } from './env';

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) return;
  const state = readState();
  const child = globalThis.__atmUiProcess;
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  } else if (state.pid) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  if (!process.env.ATM_E2E_KEEP) fs.rmSync(state.base, { recursive: true, force: true });
  fs.rmSync(STATE_FILE, { force: true });
}
