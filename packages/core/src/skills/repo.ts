import path from 'node:path';
import { expandHome } from '../context.js';
import { AtmError } from '../errors.js';

export interface RepoSpec {
  /** 清单中的原始写法 */
  spec: string;
  /** git clone 用的 URL（本地仓库为绝对路径或 file:// URL） */
  url: string;
  /** `<root>/<name>` 的目录名 */
  name: string;
  owner?: string;
}

const OWNER_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

function stripGit(s: string): string {
  return s.replace(/\/+$/, '').replace(/\.git$/, '');
}

/** 解析 `owner/repo`、完整 git URL、绝对路径 / file:// URL。 */
export function parseRepo(spec: string, home: string): RepoSpec {
  const s = spec.trim();
  if (s.startsWith('/') || s.startsWith('~/') || s.startsWith('file://')) {
    const p = s.startsWith('file://') ? decodeURIComponent(s.slice('file://'.length)) : expandHome(home, s);
    return { spec, url: s.startsWith('file://') ? s : p, name: path.basename(stripGit(p)) };
  }
  const short = OWNER_REPO.exec(s);
  if (short && !s.includes(':')) {
    return { spec, url: `https://github.com/${short[1]}/${stripGit(short[2]!)}.git`, name: stripGit(short[2]!), owner: short[1]! };
  }
  const m = /^(?:[a-z+]+:\/\/[^/]+\/|[^@\s]+@[^:\s]+:)(.+)$/.exec(s);
  if (m) {
    const parts = stripGit(m[1]!).split('/').filter(Boolean);
    const name = parts[parts.length - 1];
    if (name) {
      const out: RepoSpec = { spec, url: s, name };
      if (parts.length >= 2) out.owner = parts[parts.length - 2]!;
      return out;
    }
  }
  throw new AtmError('NOT_FOUND', `cannot parse repo "${spec}" (expected owner/repo, a git URL or an absolute path)`, {
    nextCommand: 'atm add skill <owner/repo> <name>',
  });
}

/** 规范化 git remote，用于判断「目录是否被其他仓库占用」。 */
export function normalizeRemote(url: string, home: string): string {
  let u = url.trim();
  if (u.startsWith('file://')) u = decodeURIComponent(u.slice('file://'.length));
  if (u.startsWith('/') || u.startsWith('~/')) return path.resolve(stripGit(expandHome(home, u)));
  const ssh = /^[^@\s]+@([^:\s]+):(.+)$/.exec(u);
  if (ssh) return `${ssh[1]!.toLowerCase()}/${stripGit(ssh[2]!)}`.toLowerCase();
  const http = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(u);
  if (http) return `${http[1]!.toLowerCase()}/${stripGit(http[2]!)}`.toLowerCase();
  return stripGit(u);
}

/** remote URL → 可写进清单的 repo 字符串（GitHub 用 `owner/repo`，其余原样）。 */
export function repoSlugFromRemote(remote: string): string {
  const gh = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (gh) return `${gh[1]}/${gh[2]}`;
  return remote.trim();
}
