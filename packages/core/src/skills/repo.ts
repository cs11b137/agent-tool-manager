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
/** `git@host:owner/repo`：用户名与主机名都不能以 `-` 开头 */
const SCP_LIKE = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*@[A-Za-z0-9][A-Za-z0-9.-]*:(.+)$/;
const URL_LIKE = /^(?:https|ssh):\/\/(?:[^@/\s]+@)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?\/(.+)$/;

function stripGit(s: string): string {
  return s.replace(/\/+$/, '').replace(/\.git$/, '');
}

function badSpec(spec: string, why: string): AtmError {
  return new AtmError('NOT_FOUND', `cannot parse repo "${spec}": ${why} (expected owner/repo, an https:// / ssh:// / git@host:owner/repo URL, an absolute path or a file:// URL)`, {
    nextCommand: 'atm add skill <owner/repo> <name>',
  });
}

/** owner / name 段：不能是 `.` / `..`，不能以 `.` 或 `-` 开头（会变成 `<root>` 下的目录名）。 */
function checkSegment(spec: string, seg: string | undefined, what: string): string {
  if (!seg) throw badSpec(spec, `empty ${what}`);
  if (seg === '.' || seg === '..' || seg.startsWith('.') || seg.startsWith('-')) {
    throw badSpec(spec, `invalid ${what} "${seg}"`);
  }
  return seg;
}

/** 解析 `owner/repo`、`https://` / `ssh://` / `git@host:owner/repo` URL、绝对路径 / `~/` / `file://` URL。相对路径一律拒绝。 */
export function parseRepo(spec: string, home: string): RepoSpec {
  const s = spec.trim();
  if (!s) throw badSpec(spec, 'empty spec');
  if (s.startsWith('-')) throw badSpec(spec, 'must not start with "-"');
  if (s.startsWith('/') || s.startsWith('~/') || s.startsWith('file://')) {
    const p = s.startsWith('file://') ? decodeURIComponent(s.slice('file://'.length)) : expandHome(home, s);
    if (!path.isAbsolute(p)) throw badSpec(spec, 'file:// URL must contain an absolute path');
    const name = checkSegment(spec, path.basename(stripGit(path.normalize(p))), 'repository name');
    return { spec, url: s.startsWith('file://') ? s : p, name };
  }
  const short = OWNER_REPO.exec(s);
  if (short) {
    const owner = checkSegment(spec, short[1], 'owner');
    const name = checkSegment(spec, stripGit(short[2]!), 'repository name');
    return { spec, url: `https://github.com/${owner}/${name}.git`, name, owner };
  }
  const m = URL_LIKE.exec(s) ?? SCP_LIKE.exec(s);
  if (m) {
    const parts = stripGit(m[1]!).split('/').filter(Boolean);
    for (const part of parts) if (part === '.' || part === '..') throw badSpec(spec, `invalid path segment "${part}"`);
    const name = checkSegment(spec, parts[parts.length - 1], 'repository name');
    const out: RepoSpec = { spec, url: s, name };
    if (parts.length >= 2) out.owner = checkSegment(spec, parts[parts.length - 2], 'owner');
    return out;
  }
  if (s.startsWith('.') || !s.includes(':')) throw badSpec(spec, 'relative paths are not allowed');
  throw badSpec(spec, 'unsupported URL scheme');
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
