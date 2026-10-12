import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { AtmError } from './errors.js';

/** 所有 git 调用都集中在这里，便于测试 mock。 */
export interface GitOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export function runGit(args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        signal: opts.signal,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).toString().trim();
          reject(new AtmError('GIT_FAILED', `git ${args.join(' ')} failed: ${msg}`, { nextCommand: 'atm doctor', cause: err }));
        } else {
          resolve(stdout.toString().trim());
        }
      },
    );
  });
}

async function tryGit(args: string[], opts: GitOptions): Promise<string | null> {
  try {
    return await runGit(args, opts);
  } catch {
    return null;
  }
}

export const git = {
  async isRepo(dir: string, signal?: AbortSignal): Promise<boolean> {
    return (await tryGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir, signal })) === 'true';
  },
  async isRepoRoot(dir: string, signal?: AbortSignal): Promise<boolean> {
    const top = await tryGit(['rev-parse', '--show-toplevel'], { cwd: dir, signal });
    if (!top) return false;
    try {
      return (await realpath(top)) === (await realpath(dir));
    } catch {
      return false;
    }
  },
  clone(url: string, dir: string, signal?: AbortSignal): Promise<string> {
    return runGit(['clone', '--quiet', url, dir], { signal });
  },
  head(dir: string, signal?: AbortSignal): Promise<string> {
    return runGit(['rev-parse', 'HEAD'], { cwd: dir, signal });
  },
  async tryHead(dir: string, signal?: AbortSignal): Promise<string | null> {
    return tryGit(['rev-parse', 'HEAD'], { cwd: dir, signal });
  },
  revParse(dir: string, rev: string, signal?: AbortSignal): Promise<string> {
    return runGit(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: dir, signal });
  },
  async remoteUrl(dir: string, signal?: AbortSignal): Promise<string | null> {
    return tryGit(['config', '--get', 'remote.origin.url'], { cwd: dir, signal });
  },
  async branch(dir: string, signal?: AbortSignal): Promise<string | undefined> {
    const b = await tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: dir, signal });
    return b || undefined;
  },
  async isDirty(dir: string, signal?: AbortSignal): Promise<boolean> {
    const out = await tryGit(['status', '--porcelain'], { cwd: dir, signal });
    return out !== null && out.length > 0;
  },
  async ahead(dir: string, signal?: AbortSignal): Promise<number> {
    const out = await tryGit(['rev-list', '--count', '@{u}..HEAD'], { cwd: dir, signal });
    return out ? Number.parseInt(out, 10) || 0 : 0;
  },
  async behind(dir: string, signal?: AbortSignal): Promise<{ count: number; upstream: string | null }> {
    const count = await tryGit(['rev-list', '--count', 'HEAD..@{u}'], { cwd: dir, signal });
    const upstream = await tryGit(['rev-parse', '@{u}'], { cwd: dir, signal });
    return { count: count ? Number.parseInt(count, 10) || 0 : 0, upstream };
  },
  fetch(dir: string, signal?: AbortSignal): Promise<string> {
    return runGit(['fetch', '--quiet'], { cwd: dir, signal });
  },
  pullFfOnly(dir: string, signal?: AbortSignal): Promise<string> {
    return runGit(['pull', '--ff-only', '--quiet'], { cwd: dir, signal });
  },
  worktreeAdd(dir: string, worktree: string, rev: string, signal?: AbortSignal): Promise<string> {
    return runGit(['worktree', 'add', '--detach', '--quiet', worktree, rev], { cwd: dir, signal });
  },
  worktreeRemove(dir: string, worktree: string, signal?: AbortSignal): Promise<string> {
    return runGit(['worktree', 'remove', '--force', worktree], { cwd: dir, signal });
  },
};

export type Git = typeof git;
