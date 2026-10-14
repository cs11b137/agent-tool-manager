import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api/context';
import { useDoctor, useLibrary, useProjects } from '../api/queries';
import type { BatchOp, LibraryItem, ProjectSummary } from '../api/types';
import { ErrorBox, KindChip, Loading, PageHeader, PendingBar } from '../components/ui';
import { OpFlow, specFor, type OpFlowConfig } from '../components/flows';
import { displayName, fmtTok, fmtTokShort } from '../lib/format';

const itemKey = (i: LibraryItem) => `${i.kind}:${i.name}`;
const cellKey = (i: LibraryItem, p: ProjectSummary) => `${itemKey(i)}|${p.id}`;

type CellLook = { style: CSSProperties; glyph: string };

const LOOK = {
  on: { style: { border: 0, background: 'var(--accent)', color: '#FFFFFF', boxShadow: '0 4px 14px rgba(0,102,255,.3), inset 0 1px 0 rgba(255,255,255,.35)' }, glyph: '✓' },
  off: { style: { border: '1px solid var(--line2)', background: 'var(--glass-2)', color: 'var(--ink3)' }, glyph: '' },
  add: { style: { border: '1.5px dashed var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent-ink)' }, glyph: '+' },
  remove: { style: { border: '1.5px dashed var(--err-ink)', background: 'var(--err-soft)', color: 'var(--err-ink)' }, glyph: '−' },
  na: {
    style: { border: '1px solid var(--line2)', background: 'repeating-linear-gradient(135deg, var(--line) 0 4px, transparent 4px 8px)', color: 'var(--ink3)', cursor: 'not-allowed' },
    glyph: '',
  },
} satisfies Record<string, CellLook>;

function Legend() {
  return (
    <div className="glass flex flex-wrap gap-4 rounded-full px-4 py-2.5 text-[12px] text-ink2">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-3.5 rounded-[4px] bg-accent" />
        启用
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="box-border h-3 w-3.5 rounded-[4px]" style={{ border: '1.5px dashed var(--accent)' }} />
        待提交
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-[1px]" style={{ background: 'var(--warn)', transform: 'rotate(45deg)' }} />
        有告警
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-3.5 rounded-[4px]" style={{ background: 'repeating-linear-gradient(135deg, var(--line2) 0 3px, transparent 3px 6px)' }} />
        项目缺失
      </span>
    </div>
  );
}

export function MatrixPage() {
  const api = useApi();
  const projects = useProjects();
  const library = useLibrary();
  const doctor = useDoctor();
  const [diff, setDiff] = useState<Set<string>>(new Set());
  const [flow, setFlow] = useState<OpFlowConfig | null>(null);

  const cols = projects.data ?? [];
  const rows = useMemo(() => (library.data ?? []).filter((i) => !(i.global && i.usedBy.length === 0)), [library.data]);
  const warnSet = useMemo(
    () => new Set((doctor.data?.issues ?? []).filter((i) => i.level !== 'info' && i.projectId && i.kind && i.name).map((i) => `${i.kind}:${i.name}|${i.projectId}`)),
    [doctor.data],
  );

  if (projects.isLoading || library.isLoading) return <Loading />;
  const err = projects.error ?? library.error;

  const grid = `minmax(240px, 2fr) repeat(${cols.length}, minmax(140px, 1fr)) 80px`;
  const unavailable = (i: LibraryItem, p: ProjectSummary) => !p.exists || (i.kind === 'plugin' && !p.agents.includes('claude-code'));
  const isOn = (i: LibraryItem, p: ProjectSummary) => {
    const base = i.usedBy.includes(p.id);
    return diff.has(cellKey(i, p)) ? !base : base;
  };

  const toggle = (k: string) =>
    setDiff((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const totals = cols.map((p) => {
    if (!p.exists) return null;
    let n = 0;
    let unknown = false;
    for (const i of rows) {
      if (!isOn(i, p)) continue;
      if (i.contextTokens === null) unknown = true;
      else n += i.contextTokens;
    }
    return { n, unknown };
  });

  const pendingProjects = new Set([...diff].map((k) => k.split('|')[1]));

  const preview = () => {
    const ops: BatchOp[] = [];
    for (const i of rows) {
      for (const p of cols) {
        if (!diff.has(cellKey(i, p))) continue;
        const add = !i.usedBy.includes(p.id);
        ops.push(add ? { projectId: p.id, action: 'add', spec: specFor(i) } : { projectId: p.id, action: 'remove', spec: { kind: i.kind, name: i.name } });
      }
    }
    setFlow({
      eyebrow: `矩阵 · ${pendingProjects.size} 个项目`,
      title: <span>{ops.length} 处改动</span>,
      run: (dryRun, o) => api.batch(ops, { dryRun, adopt: o.adopt, force: o.force }),
      writeOptions: ['adopt', 'force'],
      onCommitted: () => setDiff(new Set()),
      footnote: '逐项执行，单项失败不影响其他项目。合并写入只改动 lock.managed 中列出的条目，文件里手写的条目保持原样。',
    });
  };

  return (
    <>
      <PageHeader
        cap="工具 × 项目"
        title="矩阵"
        sub={<span className="text-[14px] text-ink2">点击单元格启用或停用，改动先攒成一批，统一预览 diff 后写入</span>}
        actions={<Legend />}
      />
      {err != null && <ErrorBox error={err} />}

      <section className="glass rise d1 overflow-hidden rounded-[20px]">
        <div className="overflow-x-auto">
          <div role="grid" aria-label="工具 × 项目" style={{ minWidth: 240 + cols.length * 140 + 80 }}>
            <div role="row" className="grid border-b border-line" style={{ gridTemplateColumns: grid }}>
              <span role="columnheader" className="cap px-[18px] py-4">
                工具
              </span>
              {cols.map((p) =>
                p.exists ? (
                  <Link key={p.id} role="columnheader" to={`/projects/${p.id}`} className="mono truncate px-3 py-4 text-center text-[13px] font-semibold text-ink no-underline hover:underline">
                    {p.name}
                  </Link>
                ) : (
                  <span key={p.id} role="columnheader" className="mono truncate px-3 py-4 text-center text-[13px] font-semibold text-ink3 line-through">
                    {p.name}
                  </span>
                ),
              )}
              <span role="columnheader" className="cap px-[18px] py-4 text-right">
                tokens
              </span>
            </div>

            {rows.map((i) => (
              <div key={itemKey(i)} role="row" className="hover-row grid items-center border-b border-line" style={{ gridTemplateColumns: grid }}>
                <span role="rowheader" className="flex min-w-0 items-center gap-3 px-[18px] py-2.5">
                  <KindChip kind={i.kind} className="w-[62px] shrink-0 justify-center" />
                  <span className="mono truncate text-[14px] font-medium">{displayName(i.kind, i.name)}</span>
                </span>
                {cols.map((p) => {
                  const k = cellKey(i, p);
                  const name = displayName(i.kind, i.name);
                  if (unavailable(i, p)) {
                    return (
                      <span key={p.id} role="gridcell" className="flex justify-center px-3 py-2">
                        <button type="button" className="cell" disabled aria-label={`${name} 在 ${p.name}：${p.exists ? '项目未启用 Claude Code' : '项目缺失'}`} style={LOOK.na.style} />
                      </span>
                    );
                  }
                  const changed = diff.has(k);
                  const now = isOn(i, p);
                  const look = changed ? (now ? LOOK.add : LOOK.remove) : now ? LOOK.on : LOOK.off;
                  const warn = now && !changed && warnSet.has(`${i.kind}:${i.name}|${p.id}`);
                  return (
                    <span key={p.id} role="gridcell" className="flex justify-center px-3 py-2">
                      <button
                        type="button"
                        className="cell"
                        aria-pressed={now}
                        aria-label={`${now ? '停用' : '启用'} ${name} 于 ${p.name}`}
                        data-state={changed ? 'pending' : now ? 'on' : 'off'}
                        style={{ ...look.style, cursor: 'pointer' }}
                        onClick={() => toggle(k)}
                      >
                        {look.glyph}
                        {warn && <span className="h-[7px] w-[7px] rounded-[1px]" style={{ background: '#FFC266', transform: 'rotate(45deg)' }} />}
                      </button>
                    </span>
                  );
                })}
                <span className="mono px-[18px] py-2.5 text-right text-[13px] font-semibold text-ink2">{fmtTokShort(i.contextTokens)}</span>
              </div>
            ))}

            <div role="row" className="grid items-center bg-glass-2" style={{ gridTemplateColumns: grid }}>
              <span className="px-[18px] py-4 text-[14px] font-semibold">上下文合计</span>
              {totals.map((t, idx) => (
                <span key={cols[idx]!.id} className="flex flex-col items-center gap-2 px-3 py-4">
                  <span className="mono text-[15px] font-semibold" style={{ color: t ? 'var(--ink)' : 'var(--ink3)' }}>
                    {t ? `≈ ${fmtTok(t.n)}${t.unknown ? ' + ?' : ''}` : '—'}
                  </span>
                  <span className="flex h-1.5 w-[88px] overflow-hidden rounded-full bg-line">
                    <span className="bar rounded-full bg-accent" style={{ width: t ? `${Math.min(100, t.n / 100)}%` : '0%' }} />
                  </span>
                </span>
              ))}
              <span />
            </div>
          </div>
        </div>
      </section>

      {diff.size > 0 && (
        <PendingBar label={`${diff.size} 处改动待提交 · 涉及 ${pendingProjects.size} 个项目`} onReset={() => setDiff(new Set())} onApply={preview} applyLabel="预览 diff" />
      )}

      <p className="rise d2 m-0 text-[12px] leading-[1.6] text-ink3">插件只对 Claude Code 生效；在只启用了 Cursor 的项目里，插件单元格会显示为不可用。</p>

      <OpFlow config={flow} onClose={() => setFlow(null)} />
    </>
  );
}
