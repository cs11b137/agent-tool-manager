export interface DiffResult {
  diff: string;
  additions: number;
  deletions: number;
}

type Edit = { op: ' ' | '+' | '-'; line: string };

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS 行级 diff。规模过大时退化为整体替换。 */
function lineEdits(a: string[], b: string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: Edit[] = a.slice(0, start).map((line) => ({ op: ' ', line }));
  const tail: Edit[] = a.slice(endA).map((line) => ({ op: ' ', line }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const n = ma.length;
  const m = mb.length;
  const mid: Edit[] = [];
  if (n * m > 4_000_000) {
    for (const line of ma) mid.push({ op: '-', line });
    for (const line of mb) mid.push({ op: '+', line });
    return [...head, ...mid, ...tail];
  }
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = ma[i] === mb[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) {
      mid.push({ op: ' ', line: ma[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      mid.push({ op: '-', line: ma[i++]! });
    } else {
      mid.push({ op: '+', line: mb[j++]! });
    }
  }
  while (i < n) mid.push({ op: '-', line: ma[i++]! });
  while (j < m) mid.push({ op: '+', line: mb[j++]! });
  return [...head, ...mid, ...tail];
}

/** 生成 unified diff（3 行上下文）。 */
export function unifiedDiff(relPath: string, before: string | null, after: string | null, context = 3): DiffResult {
  const a = splitLines(before);
  const b = splitLines(after);
  const edits = lineEdits(a, b);
  let additions = 0;
  let deletions = 0;
  for (const e of edits) {
    if (e.op === '+') additions++;
    else if (e.op === '-') deletions++;
  }
  if (additions === 0 && deletions === 0) return { diff: '', additions, deletions };

  const header = [`--- ${before === null ? '/dev/null' : `a/${relPath}`}`, `+++ ${after === null ? '/dev/null' : `b/${relPath}`}`];
  const out: string[] = [...header];
  // 计算每个 edit 的旧/新行号
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let nn = 1;
  for (const e of edits) {
    oldNo.push(o);
    newNo.push(nn);
    if (e.op !== '+') o++;
    if (e.op !== '-') nn++;
  }
  const changed = edits.map((e) => e.op !== ' ');
  let idx = 0;
  while (idx < edits.length) {
    if (!changed[idx]) {
      idx++;
      continue;
    }
    let start = Math.max(0, idx - context);
    let end = idx;
    // 扩展 hunk：直到连续 2*context 个未变更行
    let k = idx;
    while (k < edits.length) {
      if (changed[k]) {
        end = k;
        k++;
        continue;
      }
      let run = 0;
      while (k + run < edits.length && !changed[k + run]) run++;
      if (k + run >= edits.length || run > context * 2) break;
      k += run;
    }
    const stop = Math.min(edits.length, end + context + 1);
    const slice = edits.slice(start, stop);
    const oldCount = slice.filter((e) => e.op !== '+').length;
    const newCount = slice.filter((e) => e.op !== '-').length;
    const oldStart = oldCount === 0 ? oldNo[start]! - 1 : oldNo[start]!;
    const newStart = newCount === 0 ? newNo[start]! - 1 : newNo[start]!;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const e of slice) out.push(e.op + e.line);
    idx = stop;
    start = stop;
  }
  return { diff: out.join('\n') + '\n', additions, deletions };
}
