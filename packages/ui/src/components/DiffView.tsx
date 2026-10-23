import { msg, useLocale } from '../lib/i18n';
import { useMemo, useState } from 'react';
import type { DiffFile } from '../lib/changes';
import { fileMode, fileStat } from '../lib/changes';
import { parseDiff, type DiffLine } from '../lib/diff';

const LINE_STYLE: Record<DiffLine['kind'], { bg: string; color: string; sign: string }> = {
  add: { bg: 'var(--ok-soft)', color: 'var(--ok-ink)', sign: '+' },
  del: { bg: 'var(--err-soft)', color: 'var(--err-ink)', sign: '−' },
  ctx: { bg: 'transparent', color: 'var(--ink3)', sign: '' },
  note: { bg: 'transparent', color: 'var(--ink2)', sign: '' },
  hunk: { bg: 'var(--line)', color: 'var(--ink3)', sign: '⋯' },
};

function linesOf(f: DiffFile): DiffLine[] {
  const parsed = parseDiff(f.change.diff);
  if (parsed.length) return parsed;
  // unchanged file (e.g. 查看生成的配置): show content as context
  const content = f.change.type === 'symlink' ? `${f.change.relPath} → ${f.change.target ?? f.change.after ?? ''}` : (f.change.after ?? f.change.before ?? '');
  return content
    .replace(/\n$/, '')
    .split('\n')
    .map((text) => ({ kind: 'ctx' as const, text }));
}

export function DiffLines({ lines }: { lines: DiffLine[] }) {
  useLocale();
  return (
    <div className="overflow-x-auto py-2" style={{ maxHeight: 440 }}>
      {lines.map((l, i) => {
        const s = LINE_STYLE[l.kind];
        return (
          <div
            key={i}
            data-diff={l.kind}
            className="mono flex min-w-max"
            style={{ background: s.bg, color: s.color, fontSize: l.kind === 'hunk' ? 11 : 13, lineHeight: 1.8 }}
          >
            <span className="w-8 shrink-0 text-center opacity-80 select-none">{s.sign}</span>
            <span className="pr-4 whitespace-pre">{l.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Tabs per file with +N −M, then a unified diff panel (prototype 03). */
export function DiffTabs({ files, initial }: { files: DiffFile[]; initial?: number }) {
  useLocale();
  const defaultIdx = useMemo(() => {
    if (initial !== undefined) return initial;
    const i = files.findIndex((f) => f.change.agent && f.change.type === 'file');
    return i >= 0 ? i : 0;
  }, [files, initial]);
  const [picked, setPicked] = useState<string | null>(null);
  const idx = Math.max(0, picked ? files.findIndex((f) => f.key === picked) : defaultIdx);
  const cur = files[idx];
  const multiProject = new Set(files.map((f) => f.projectName ?? '')).size > 1;
  if (!cur) return null;
  return (
    <>
      <div role="tablist" aria-label={msg("文件")} className="flex flex-wrap gap-1.5">
        {files.map((f, i) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            className="tab"
            aria-selected={i === idx}
            aria-controls="diff-panel"
            onClick={() => setPicked(f.key)}
          >
            {f.label}
            <span className="text-[11px] opacity-75">{fileStat(f.change)}</span>
          </button>
        ))}
      </div>
      <div id="diff-panel" role="tabpanel" aria-label={cur.change.relPath} className="overflow-hidden rounded-[8px] border border-line2 bg-field">
        <div className="mono flex justify-between gap-3 border-b border-line px-4 py-2.5 text-[12px] text-ink2">
          <span className="min-w-0 truncate">
            {multiProject && cur.projectName && !cur.change.relPath.startsWith('~') ? `${cur.projectName} · ` : ''}
            {cur.change.relPath}
          </span>
          <span className="shrink-0 font-sans">{fileMode(cur.change)}</span>
        </div>
        <DiffLines lines={linesOf(cur)} />
      </div>
    </>
  );
}
