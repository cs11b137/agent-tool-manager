import type {
  ContextBreakdown,
  DoctorIssue,
  DoctorLevel,
  DoctorReport,
  FileChange,
  ProjectDetail,
  ProjectSummary,
  SearchResult,
  SyncResult,
  ToolEntry,
  ToolKind,
  WriteResult,
} from '@atm/core';

// ───────────────────────────── colors ─────────────────────────────

export type Paint = (s: string) => string;

export interface Colors {
  red: Paint;
  green: Paint;
  yellow: Paint;
  blue: Paint;
  cyan: Paint;
  gray: Paint;
  bold: Paint;
  dim: Paint;
}

const code =
  (open: number, close: number): Paint =>
  (s) =>
    s === '' ? s : `\x1b[${open}m${s}\x1b[${close}m`;

const ANSI: Colors = {
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  cyan: code(36, 39),
  gray: code(90, 39),
  bold: code(1, 22),
  dim: code(2, 22),
};

const id: Paint = (s) => s;
const PLAIN: Colors = { red: id, green: id, yellow: id, blue: id, cyan: id, gray: id, bold: id, dim: id };

export function colors(enabled: boolean): Colors {
  return enabled ? ANSI : PLAIN;
}

export function useColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  return Boolean(stream.isTTY) && !('NO_COLOR' in env && env.NO_COLOR !== '');
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string): number => [...s.replace(ANSI_RE, '')].length;

// ───────────────────────────── helpers ─────────────────────────────

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '?';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
}

export function fmtContext(c: ContextBreakdown, k: Colors): string {
  const parts = [`skill ${fmtTokens(c.skill)}`, `mcp ${fmtTokens(c.mcp)}`, `plugin ${fmtTokens(c.plugin)}`];
  if (c.unmeasured) parts.push(k.yellow(`${c.unmeasured} unmeasured`));
  return `context ≈ ${k.bold(fmtTokens(c.total))} tokens  ${k.gray('(')}${parts.join(k.gray(' · '))}${k.gray(')')}`;
}

type Cell = string;

/** Left-aligned table; column widths ignore ANSI codes. `right` = indexes of right-aligned columns. */
export function table(rows: Cell[][], opts: { indent?: string; right?: number[] } = {}): string[] {
  const indent = opts.indent ?? '  ';
  const right = new Set(opts.right ?? []);
  const widths: number[] = [];
  for (const row of rows) row.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(c))));
  return rows.map((row) =>
    (
      indent +
      row
        .map((c, i) => {
          const pad = ' '.repeat((widths[i] ?? 0) - visibleLength(c));
          if (right.has(i)) return pad + c;
          return i === row.length - 1 ? c : c + pad;
        })
        .join('  ')
    ).trimEnd(),
  );
}

function truncate(s: string, max: number): string {
  return [...s].length > max ? [...s].slice(0, max - 1).join('') + '…' : s;
}

// ───────────────────────────── write results ─────────────────────────────

function fileMark(f: FileChange, k: Colors): string {
  if (f.type === 'dir') return k.cyan('d');
  if (f.type === 'symlink') return f.after === null ? k.red('-') : k.cyan('→');
  if (f.before === null) return k.green('+');
  if (f.after === null) return k.red('-');
  return k.yellow('M');
}

export function colorDiff(diff: string, k: Colors): string[] {
  const lines = diff.replace(/\n$/, '').split('\n');
  return lines.map((l) => {
    if (l.startsWith('+++') || l.startsWith('---')) return k.bold(l);
    if (l.startsWith('@@')) return k.cyan(l);
    if (l.startsWith('+')) return k.green(l);
    if (l.startsWith('-')) return k.red(l);
    return l;
  });
}

export function renderWrite(title: string, r: WriteResult, k: Colors): string[] {
  const out: string[] = [];
  if (!r.files.length) out.push(`${k.green('✔')} ${title} ${k.gray('— nothing to change')}`);
  else if (r.applied) out.push(`${k.green('✔')} ${title}`);
  else out.push(`${k.cyan('◇')} ${title} ${k.gray('— dry run, nothing written')}`);

  if (r.files.length) {
    const rows = r.files.map((f) => {
      const name = f.relPath + (f.type === 'dir' ? '/' : '');
      const stat = f.type === 'file' ? `${k.green('+' + f.additions)} ${k.red('-' + f.deletions)}` : '';
      const note = f.type === 'symlink' && f.after !== null ? k.gray('-> ' + (f.target ?? f.after)) : f.agent ? k.gray(f.agent) : '';
      return [fileMark(f, k), name, stat, note];
    });
    out.push(...table(rows));
    const adds = r.files.reduce((s, f) => s + f.additions, 0);
    const dels = r.files.reduce((s, f) => s + f.deletions, 0);
    out.push(k.gray(`  ${r.files.length} file${r.files.length === 1 ? '' : 's'} `) + `${k.green('+' + adds)} ${k.red('-' + dels)}`);
  }

  if (!r.applied && r.files.length) {
    for (const f of r.files) {
      if (!f.diff) continue;
      out.push('');
      out.push(...colorDiff(f.diff, k));
    }
    out.push('');
  }

  for (const w of r.warnings) out.push(k.yellow(`! ${w}`));
  if (r.contextAfter) out.push(k.gray('  ') + fmtContext(r.contextAfter, k));
  return out;
}

// ───────────────────────────── list ─────────────────────────────

const KIND_TITLE: Record<ToolKind, string> = { skill: 'Skills', mcp: 'MCP', plugin: 'Plugins' };

function toolVersion(t: ToolEntry): string {
  if (t.skill) return t.skill.commit.slice(0, 7) + (t.skill.rev ? ` @${t.skill.rev}` : '') || '-';
  if (t.mcp) return t.mcp.hash.replace(/^sha256:/, '').slice(0, 7) || '-';
  if (t.plugin) return t.plugin.version ?? '-';
  return '-';
}

function toolStatus(t: ToolEntry, k: Colors): string {
  if (t.skill?.broken) return k.red('broken link');
  if (t.skill && !t.skill.linked) return k.red('not linked');
  if (t.plugin && !t.plugin.installed) return k.red('not installed');
  if (t.mcp) {
    const unset = t.mcp.envVars.filter((v) => !v.set).map((v) => v.name);
    if (unset.length) return k.yellow(`unset: ${unset.join(', ')}`);
  }
  return '';
}

export function renderList(d: ProjectDetail, k: Colors): string[] {
  const out: string[] = [];
  out.push(`${k.bold(d.name)} ${k.gray(d.path)}`);
  out.push(k.gray(`agents: ${d.agents.join(', ') || '-'}`));
  if (!d.tools.length) {
    out.push('', k.gray('no tools yet — atm add skill <owner/repo> <name> | atm add mcp <name> | atm add plugin <plugin@marketplace>'));
  }
  for (const kind of ['skill', 'mcp', 'plugin'] as const) {
    const tools = d.tools.filter((t) => t.kind === kind);
    if (!tools.length) continue;
    out.push('', k.bold(`${KIND_TITLE[kind]} (${tools.length})`));
    const rows = [[k.gray('NAME'), k.gray('SOURCE'), k.gray(kind === 'skill' ? 'COMMIT' : kind === 'mcp' ? 'HASH' : 'VERSION'), k.gray('TOKENS'), k.gray('AGENTS'), '']];
    for (const t of tools) {
      rows.push([t.name, k.gray(t.source), k.dim(toolVersion(t)), t.contextTokens === null ? k.yellow('?') : fmtTokens(t.contextTokens), t.agents.join(','), toolStatus(t, k)]);
    }
    out.push(...table(rows, { right: [3] }));
  }
  out.push('', fmtContext(d.context, k));
  const c = d.doctor;
  if (c.error || c.warn) {
    out.push(`${c.error ? k.red(`✖ ${c.error} error`) : ''}${c.error && c.warn ? '  ' : ''}${c.warn ? k.yellow(`⚠ ${c.warn} warn`) : ''}  ${k.gray('→ atm doctor')}`);
  }
  return out;
}

// ───────────────────────────── doctor ─────────────────────────────

const LEVELS: Array<{ level: DoctorLevel; title: string; icon: string; color: keyof Colors }> = [
  { level: 'error', title: 'Errors', icon: '✖', color: 'red' },
  { level: 'warn', title: 'Warnings', icon: '⚠', color: 'yellow' },
  { level: 'info', title: 'Info', icon: 'ℹ', color: 'blue' },
];

export function renderDoctor(r: DoctorReport, k: Colors, multi: boolean): string[] {
  const out: string[] = [];
  const c = r.counts;
  const count = (n: number, label: string, paint: Paint): string => (n ? paint(`${label.slice(0, 1)} ${n} ${label.slice(2)}`) : k.gray(`${label.slice(0, 1)} 0 ${label.slice(2)}`));
  const head = [count(c.error, '✖ error', k.red), count(c.warn, '⚠ warn', k.yellow), count(c.info, 'ℹ info', k.blue)].join('  ');
  const scope = multi ? `${r.projects.length} project${r.projects.length === 1 ? '' : 's'}` : (r.projects[0]?.name ?? '');
  out.push(`${head}  ${k.gray(`— ${scope}${r.measured ? ', measured' : ''}`)}`);
  for (const { level, title, icon, color } of LEVELS) {
    const issues = r.issues.filter((i) => i.level === level);
    if (!issues.length) continue;
    out.push('', k.bold(k[color](title)));
    for (const i of issues) out.push(...renderIssue(i, icon, k[color], k, multi));
  }
  if (!r.issues.length) out.push('', k.green('✔ all good'));
  return out;
}

function renderIssue(i: DoctorIssue, icon: string, paint: Paint, k: Colors, multi: boolean): string[] {
  const prefix = multi && i.projectName ? k.gray(`[${i.projectName}] `) : '';
  const out = [`  ${paint(icon)} ${prefix}${i.title} ${k.gray(i.code)}`];
  if (i.detail) out.push(k.gray(`      ${i.detail}`));
  if (i.nextCommand) out.push(`      ${k.cyan('→')} ${i.nextCommand}`);
  return out;
}

// ───────────────────────────── other commands ─────────────────────────────

export function renderSync(r: SyncResult, k: Colors): string[] {
  if (!r.repos.length) return [k.gray('no repositories to sync')];
  const statusColor = (s: SyncResult['repos'][number]['status']): Paint =>
    s === 'updated' || s === 'cloned' ? k.green : s === 'up-to-date' ? k.gray : s === 'failed' ? k.red : k.yellow;
  const rows = r.repos.map((row) => {
    const move = row.from && row.to && row.from !== row.to ? `${row.from.slice(0, 7)} → ${row.to.slice(0, 7)}` : (row.to ?? row.from ?? '').slice(0, 7);
    return [statusColor(row.status)(row.status), row.repo, k.dim(move), row.message ? k.gray(row.message) : ''];
  });
  const out = table(rows);
  if (r.updatedProjects.length) out.push(k.gray(`  lock updated in ${r.updatedProjects.length} project${r.updatedProjects.length === 1 ? '' : 's'}`));
  return out;
}

export function renderSearch(r: SearchResult, query: string, k: Colors): string[] {
  if (!r.items.length) return [k.gray(`no match for "${query}"`)];
  const rows = r.items.map((i) => [
    k.cyan(i.kind.padEnd(6)),
    i.name,
    k.gray(i.source),
    i.contextTokens === null ? k.yellow('?') : fmtTokens(i.contextTokens),
    k.dim(truncate(i.description ?? '', 60)),
  ]);
  return table(rows, { right: [3] });
}

export function renderProjects(list: ProjectSummary[], k: Colors): string[] {
  if (!list.length) return [k.gray('no registered projects — run `atm init` in a project')];
  const rows = [[k.gray('ID'), k.gray('NAME'), k.gray('TOOLS'), k.gray('CONTEXT'), k.gray('DOCTOR'), k.gray('PATH')]];
  for (const p of list) {
    const tools = p.initialized ? `${p.counts.skills}s ${p.counts.mcp}m ${p.counts.plugins}p` : k.gray('not initialized');
    const doc = !p.exists ? k.red('missing') : p.doctor.error ? k.red(`${p.doctor.error} error`) : p.doctor.warn ? k.yellow(`${p.doctor.warn} warn`) : k.green('ok');
    rows.push([k.dim(p.id), p.exists ? p.name : k.gray(p.name), tools, fmtTokens(p.context.total), doc, k.gray(p.path)]);
  }
  return table(rows, { right: [3] });
}
