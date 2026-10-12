import type { BatchResult, FileChange, ProjectSummary, WriteResult } from '../api/types';
import { AGENT_LABEL } from './format';
import { unifiedDiff } from './diff';

export interface DiffFile {
  key: string;
  /** tab label: `tools.json`, `.mcp.json`, or `web-app/.mcp.json` when several projects are involved */
  label: string;
  projectName?: string;
  change: FileChange;
}

/** Normalised preview of one or more dryRun results. */
export interface WritePreview {
  files: DiffFile[];
  warnings: string[];
  commands: string[];
  errors: string[];
}

function findProject(path: string, projects: ProjectSummary[]): ProjectSummary | undefined {
  return projects
    .filter((p) => path === p.path || path.startsWith(`${p.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** Merge changes to the same path (batch ops on one project) into a single before→after diff. */
export function mergeChanges(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const c of changes) {
    const prev = byPath.get(c.path);
    if (!prev) {
      byPath.set(c.path, c);
      continue;
    }
    if (c.type === 'file' && prev.type === 'file') {
      const d = unifiedDiff(prev.before, c.after, c.relPath);
      byPath.set(c.path, { ...c, before: prev.before, ...d });
    } else {
      const added = prev.before === null;
      const removed = c.after === null;
      byPath.set(c.path, {
        ...c,
        before: prev.before,
        diff: [prev.diff, c.diff].filter(Boolean).join('\n'),
        additions: added || !removed ? 1 : 0,
        deletions: removed || !added ? 1 : 0,
      });
    }
  }
  return [...byPath.values()].filter((c) => c.before !== c.after || c.diff);
}

export function toDiffFiles(changes: FileChange[], projects: ProjectSummary[] = []): DiffFile[] {
  const merged = mergeChanges(changes);
  const owners = merged.map((c) => findProject(c.path, projects));
  const distinct = new Set(owners.map((o) => o?.id ?? ''));
  const multi = distinct.size > 1;
  return merged.map((c, i) => {
    const owner = owners[i];
    const base = c.relPath.startsWith('.agents/') && !c.relPath.startsWith('.agents/skills/') ? c.relPath.slice('.agents/'.length) : c.relPath;
    const label = multi && owner && !c.relPath.startsWith('~') ? `${owner.name}/${base}` : base;
    return { key: c.path, label, ...(owner ? { projectName: owner.name } : {}), change: c };
  });
}

export function fromWriteResults(results: WriteResult[], projects: ProjectSummary[] = [], errors: string[] = []): WritePreview {
  return {
    files: toDiffFiles(
      results.flatMap((r) => r.files),
      projects,
    ),
    warnings: [...new Set(results.flatMap((r) => r.warnings))],
    commands: [...new Set(results.map((r) => r.command).filter((c): c is string => !!c))],
    errors,
  };
}

export function fromBatch(res: BatchResult, projects: ProjectSummary[] = []): WritePreview {
  const ok: WriteResult[] = [];
  const errors: string[] = [];
  for (const r of res.results) {
    if ('error' in r.result) {
      const p = projects.find((x) => x.id === r.projectId);
      errors.push(`${p?.name ?? r.projectId}：${r.result.error}`);
    } else ok.push(r.result);
  }
  const preview = fromWriteResults(ok, projects, errors);
  // per-project commands: prefix with cd when several projects are involved
  const ids = [...new Set(res.results.map((r) => r.projectId))];
  if (ids.length > 1) {
    preview.commands = res.results
      .filter((r) => !('error' in r.result) && r.result.command)
      .map((r) => {
        const p = projects.find((x) => x.id === r.projectId);
        return `${p ? `(${p.name}) ` : ''}${(r.result as WriteResult).command!}`;
      });
  }
  return preview;
}

export function fileMode(c: FileChange): string {
  if (c.relPath.startsWith('~')) return `${c.agent ? `${AGENT_LABEL[c.agent]} · ` : ''}全局配置`;
  if (c.type === 'symlink') return '软链 · 不提交';
  if (c.type === 'dir') return '目录';
  if (c.relPath.endsWith('tools.json')) return '清单 · 提交';
  if (c.relPath.endsWith('tools.lock.json')) return '锁文件 · 提交';
  if (c.agent) return `${AGENT_LABEL[c.agent]} · 提交`;
  return '提交';
}

export function fileStat(c: FileChange): string {
  return `+${c.additions} −${c.deletions}`;
}
