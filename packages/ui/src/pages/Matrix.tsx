import { msg, useLocale } from '../lib/i18n';
import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api/context';
import { useDoctor, useLibrary, useProjects } from '../api/queries';
import type { BatchOp, LibraryItem, ProjectSummary } from '../api/types';
import { Empty, ErrorBox, KindChip, Loading, PageHeader, PendingBar } from '../components/ui';
import { OpFlow, specFor, type OpFlowConfig } from '../components/flows';
import { displayName, fmtTok, fmtTokShort } from '../lib/format';

const itemKey = (i: LibraryItem) => `${i.kind}:${i.name}`;
const cellKey = (i: LibraryItem, p: ProjectSummary) => `${itemKey(i)}|${p.id}`;

type CellLook = { style: CSSProperties; glyph: string };

const LOOK = {
  on: { style: { border: 0, background: 'var(--accent)', color: '#FFFFFF' }, glyph: '✓' },
  off: { style: { border: '1px solid var(--line2)', background: 'transparent', color: 'var(--ink3)' }, glyph: '' },
  add: { style: { border: '1.5px dashed var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent-ink)' }, glyph: '+' },
  remove: { style: { border: '1.5px dashed var(--err-ink)', background: 'var(--err-soft)', color: 'var(--err-ink)' }, glyph: '−' },
  na: {
    style: { border: '1px solid var(--line2)', background: 'repeating-linear-gradient(135deg, var(--line) 0 4px, transparent 4px 8px)', color: 'var(--ink3)', cursor: 'not-allowed' },
    glyph: '',
  },
} satisfies Record<string, CellLook>;

function Legend() {
  useLocale();
  return (
    <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-ink3">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-3.5 rounded-[4px] bg-accent" />
        {msg("启用")}</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="box-border h-3 w-3.5 rounded-[4px]" style={{ border: '1.5px dashed var(--accent)' }} />
        {msg("待提交")}</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-[1px]" style={{ background: 'var(--warn)', transform: 'rotate(45deg)' }} />
        {msg("有告警")}</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-3.5 rounded-[4px]" style={{ background: 'repeating-linear-gradient(135deg, var(--line2) 0 3px, transparent 3px 6px)' }} />
        {msg("项目缺失")}</span>
    </div>
  );
}

export function MatrixPage() {
  useLocale();
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
      eyebrow: msg("矩阵 · {0} 个项目", {0: pendingProjects.size}),
      title: <span>{ops.length} {msg("处改动")}</span>,
      run: (dryRun, o) => api.batch(ops, { dryRun, adopt: o.adopt, force: o.force }),
      writeOptions: ['adopt', 'force'],
      onCommitted: () => setDiff(new Set()),
      footnote: msg("逐项执行，单项失败不影响其他项目。合并写入只改动 lock.managed 中列出的条目，文件里手写的条目保持原样。"),
    });
  };

  return (
    <>
      <PageHeader
        cap={msg("工具 × 项目")}
        title={msg("矩阵")}
        sub={<span className="text-[14px] text-ink2">{msg("点击单元格启用或停用，改动先攒成一批，统一预览 diff 后写入")}</span>}
        actions={<Legend />}
      />
      {err != null && <ErrorBox error={err} />}

      {!rows.length || !cols.length ? <Empty className="glass rounded-[8px] p-8">
        <strong className="block text-base text-ink">{msg(!rows.length ? '还没有可关联的工具' : '先添加一个项目')}</strong>
        <p>{msg(!rows.length ? '先在工具库创建工具，再添加项目。' : '添加项目后，即可在这里勾选要关联的工具。')}</p>
        <Link className="btn btn-p" to="/library">{msg('前往工具库')}</Link>
      </Empty> : <section className="tbl">
        <div className="overflow-x-auto">
          <div role="grid" aria-label={msg("工具 × 项目")} style={{ minWidth: 240 + cols.length * 140 + 80 }}>
            <div role="row" className="grid border-b border-line" style={{ gridTemplateColumns: grid }}>
              <span role="columnheader" className="cap px-[14px] py-2.5">
                {msg("工具")}</span>
              {cols.map((p) =>
                p.exists ? (
                  <Link key={p.id} role="columnheader" to={`/projects/${p.id}`} className="mono truncate px-3 py-2.5 text-center text-[13px] font-semibold text-ink no-underline hover:underline">
                    {p.name}
                  </Link>
                ) : (
                  <span key={p.id} role="columnheader" className="mono truncate px-3 py-2.5 text-center text-[13px] font-semibold text-ink3 line-through">
                    {p.name}
                  </span>
                ),
              )}
              <span role="columnheader" className="cap px-[14px] py-2.5 text-right">
                tokens
              </span>
            </div>

            {rows.map((i) => (
              <div key={itemKey(i)} role="row" className="hover-row grid items-center border-b border-line" style={{ gridTemplateColumns: grid }}>
                <span role="rowheader" className="flex min-w-0 items-center gap-3 px-[14px] py-2">
                  <KindChip kind={i.kind} className="w-[62px] shrink-0 justify-center" />
                  <span className="mono truncate text-[14px] font-medium">{displayName(i.kind, i.name)}</span>
                </span>
                {cols.map((p) => {
                  const k = cellKey(i, p);
                  const name = displayName(i.kind, i.name);
                  if (unavailable(i, p)) {
                    return (
                      <span key={p.id} role="gridcell" className="flex justify-center px-3 py-2">
                        <button type="button" className="cell" disabled aria-label={msg("{0} 在 {1}：{2}", {0: name, 1: p.name, 2: p.exists ? msg('项目未启用 Claude Code') : msg('项目缺失')})} style={LOOK.na.style} />
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
                        aria-label={msg("{0} {1} 于 {2}", {0: now ? msg('停用') : msg('启用'), 1: name, 2: p.name})}
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
                <span className="mono px-[14px] py-2 text-right text-[13px] font-semibold text-ink2">{fmtTokShort(i.contextTokens)}</span>
              </div>
            ))}

            <div role="row" className="grid items-center bg-surface-2" style={{ gridTemplateColumns: grid }}>
              <span className="px-[18px] py-4 text-[14px] font-semibold">{msg("上下文合计")}</span>
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
      </section>}

      {diff.size > 0 && (
        <PendingBar label={msg("{0} 处改动待提交 · 涉及 {1} 个项目", {0: diff.size, 1: pendingProjects.size})} onReset={() => setDiff(new Set())} onApply={preview} applyLabel={msg("预览 diff")} />
      )}

      <p className="m-0 text-[12px] leading-[1.6] text-ink3">{msg("插件只对 Claude Code 生效；在只启用了 Cursor 的项目里，插件单元格会显示为不可用。")}</p>

      <OpFlow config={flow} onClose={() => setFlow(null)} />
    </>
  );
}
