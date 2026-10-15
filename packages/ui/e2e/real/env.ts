import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');
export const CLI_BIN = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');
/** Written by global-setup, read by the specs and global-teardown. */
export const STATE_FILE = path.join(here, '..', '..', 'test-results', 'real-e2e-state.json');

export interface RealState {
  base: string;
  home: string;
  /** `<home>/src/baoyu-skills` — local git repo used as the skill source */
  repo: string;
  /** `<home>/.agent-tools` */
  root: string;
  projGui: string;
  projCli: string;
  url: string;
  origin: string;
  token: string;
  pid: number;
}

export function readState(): RealState {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as RealState;
}

/** Environment for every CLI / git invocation: isolated HOME, no colours, deterministic git identity. */
export function cliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const k of Object.keys(env)) if (/^(FIGMA_API_KEY|LINEAR_TOKEN|ATM_.*|XDG_CONFIG_HOME|GIT_DIR|GIT_WORK_TREE)$/.test(k)) delete env[k];
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'atm e2e',
    GIT_AUTHOR_EMAIL: 'e2e@atm.local',
    GIT_COMMITTER_NAME: 'atm e2e',
    GIT_COMMITTER_EMAIL: 'e2e@atm.local',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  return env;
}

/** Runs `atm <args>` with the temp HOME. Throws (with stdout/stderr) on non-zero exit. */
export function atm(home: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [CLI_BIN, ...args], { env: cliEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    throw new Error(`atm ${args.join(' ')} exited ${err.status}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`);
  }
}

export function git(home: string, cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cliEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
