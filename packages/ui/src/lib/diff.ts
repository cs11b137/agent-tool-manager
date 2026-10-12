/** Minimal line-based unified diff (LCS). Used by the mock server and to merge batch results client-side. */

export interface DiffStat {
  diff: string;
  additions: number;
  deletions: number;
}

type Op = { t: ' ' | '+' | '-'; line: string };

function splitLines(s: string | null): string[] {
  if (s === null || s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ t: '-', line: a[i]! });
      i++;
    } else {
      ops.push({ t: '+', line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', line: a[i++]! });
  while (j < m) ops.push({ t: '+', line: b[j++]! });
  return ops;
}

export function unifiedDiff(before: string | null, after: string | null, relPath = 'file', context = 3): DiffStat {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = lcsOps(a, b);
  let additions = 0;
  let deletions = 0;
  for (const o of ops) {
    if (o.t === '+') additions++;
    else if (o.t === '-') deletions++;
  }
  if (additions === 0 && deletions === 0) return { diff: '', additions, deletions };

  // group into hunks
  const out: string[] = [`--- ${before === null ? '/dev/null' : `a/${relPath}`}`, `+++ ${after === null ? '/dev/null' : `b/${relPath}`}`];
  const changed = ops.map((o) => o.t !== ' ');
  let k = 0;
  // positions in a/b for each op index
  const aPos: number[] = [];
  const bPos: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const o of ops) {
    aPos.push(ai);
    bPos.push(bi);
    if (o.t !== '+') ai++;
    if (o.t !== '-') bi++;
  }
  while (k < ops.length) {
    if (!changed[k]) {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    // extend while next change is within 2*context
    let last = k;
    for (let x = k; x < ops.length; x++) {
      if (changed[x]) last = x;
      else if (x - last > context * 2) break;
    }
    end = Math.min(ops.length, last + context + 1);
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o.t !== '+').length;
    const bCount = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aCount ? aPos[start]! + 1 : aPos[start]!},${aCount} +${bCount ? bPos[start]! + 1 : bPos[start]!},${bCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    k = end;
  }
  return { diff: out.join('\n'), additions, deletions };
}

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'note';
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Parses unified diff text (or a short symlink/dir description) into renderable lines. */
export function parseDiff(text: string): DiffLine[] {
  if (!text) return [];
  const lines: DiffLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    if (raw.startsWith('@@')) lines.push({ kind: 'hunk', text: raw });
    else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1) });
    else if (raw.startsWith(' ')) lines.push({ kind: 'ctx', text: raw.slice(1) });
    else if (raw.startsWith('\\')) continue;
    else lines.push({ kind: 'note', text: raw });
  }
  return lines;
}
