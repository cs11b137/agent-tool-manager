import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api/context';
import { useActivity, useConfig, useDoctor, useLibrary, useProjects, useRepos } from '../api/queries';
import type { ActivityEntry, ProjectSummary, WriteResult } from '../api/types';
import { ContextBar, DoctorChip, Empty, ErrorBox, KindChip, Loading, PageHeader, Rich } from '../components/ui';
import { OpFlow, type OpFlowConfig } from '../components/flows';
import { RelocateDialog, UnregisterDialog } from '../components/dialogs';
import { useConnection } from '../components/LiveProvider';
import { useToast } from '../components/Toaster';
import { AGENT_LABEL, fmtTok, hhmm, tildify } from '../lib/format';

function Stat({ cap, value, sub }: { cap: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="glass flex flex-col gap-1 rounded-[16px] px-[18px] py-4">
      <span className="cap">{cap}</span>
      <span className="mono text-[28px] font-semibold">{value}</span>
      <span className="text-[12px] text-ink3">{sub}</span>
    </div>
  );
}

function ProjectCard({ p, featured, delay, onInstall, onFix, fixable }: { p: ProjectSummary; featured: boolean; delay: number; onInstall: () => void; onFix: () => void; fixable: number }) {
  const c = p.counts;
  return (
    <article
      className={`glass lift rise d${delay} flex flex-col gap-4 rounded-[20px] p-[22px] ${featured ? 'iri' : ''}`}
      style={featured ? { background: 'var(--glass-strong)' } : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="mono m-0 text-[18px] font-semibold">{p.name}</h2>
          <span className="mono text-[12px] break-all text-ink3">{tildify(p.path)}</span>
        </div>
        <DoctorChip counts={p.doctor} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {p.agents.map((a) => (
          <span key={a} className="chip c-agent">
            {AGENT_LABEL[a]}
          </span>
        ))}
        {!p.initialized && <span className="chip c-muted font-sans">未初始化</span>}
      </div>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-ink2">常驻上下文</span>
        <span className={`mono text-[26px] font-semibold ${featured ? 'ca' : ''}`}>
          ≈ {fmtTok(p.context.total)}
          {p.context.unmeasured > 0 && <span className="text-[14px] text-ink3"> + ?</span>}
        </span>
      </div>
      <ContextBar context={p.context} />
      <div className="flex flex-wrap gap-2">
        <span className={`chip ${c.skills ? 'c-skill' : 'c-muted'}`}>SKILL {c.skills}</span>
        <span className={`chip ${c.mcp ? 'c-mcp' : 'c-muted'}`}>MCP {c.mcp}</span>
        <span className={`chip ${c.plugins ? 'c-plugin' : 'c-muted'}`}>PLUGIN {c.plugins}</span>
      </div>
      <div className="mt-auto flex gap-2 border-t border-line pt-4">
        <Link to={`/projects/${p.id}`} className="btn btn-p">
          打开
        </Link>
        {fixable > 0 ? (
          <button type="button" className="btn btn-g" onClick={onFix}>
            修复断链
          </button>
        ) : (
          <button type="button" className="btn btn-g" onClick={onInstall}>
            install
          </button>
        )}
      </div>
    </article>
  );
}

function MissingCard({ p, delay, onRelocate, onRemove }: { p: ProjectSummary; delay: number; onRelocate: () => void; onRemove: () => void }) {
  return (
    <article
      className={`rise d${delay} flex flex-col gap-4 rounded-[20px] p-[22px]`}
      style={{ border: '1.5px dashed var(--line2)', background: 'repeating-linear-gradient(135deg, var(--glass-2) 0 8px, transparent 8px 16px)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="mono m-0 text-[18px] font-semibold text-ink3">{p.name}</h2>
          <span className="mono text-[12px] break-all text-ink3">{tildify(p.path)}</span>
        </div>
        <span className="chip c-muted font-sans !text-ink2">目录不存在</span>
      </div>
      <p className="m-0 text-[14px] leading-[1.6] text-ink2">
        注册表里还记着这个项目，但目录已经找不到了。只是移动了位置的话可以重新定位；否则从注册表移除，不会删除任何文件。
      </p>
      <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-4">
        <button type="button" className="btn btn-g" onClick={onRelocate}>
          重新定位…
        </button>
        <button type="button" className="btn btn-d" onClick={onRemove}>
          从注册表移除
        </button>
      </div>
    </article>
  );
}

function ActivityRow({ e, last }: { e: ActivityEntry; last: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 px-5 py-[13px] text-[14px] ${last ? '' : 'border-b border-line'}`}>
      <span className="mono w-[52px] text-[12px] text-ink3">{hhmm(e.at)}</span>
      {e.level === 'error' ? (
        <span className="chip" style={{ background: 'var(--err-soft)', color: 'var(--err-ink)' }}>
          ERROR
        </span>
      ) : e.kind ? (
        <KindChip kind={e.kind} />
      ) : e.level === 'warn' ? (
        <span className="chip" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          WARN
        </span>
      ) : (
        <span className="chip c-muted">INFO</span>
      )}
      {e.projectName &&
        (e.projectId ? (
          <Link to={`/projects/${e.projectId}`} className="mono text-[13px] text-ink no-underline hover:underline">
            {e.projectName}
          </Link>
        ) : (
          <span className="mono text-[13px]">{e.projectName}</span>
        ))}
      <span style={{ color: e.level === 'error' ? 'var(--err-ink)' : e.level === 'warn' ? 'var(--warn-ink)' : 'var(--ink2)' }}>
        <Rich text={e.message} codeClass={e.level === 'info' ? 'text-ink' : ''} />
      </span>
    </div>
  );
}

export function OverviewPage() {
  const api = useApi();
  const toast = useToast();
  const conn = useConnection();
  const projects = useProjects();
  const config = useConfig();
  const doctor = useDoctor();
  const repos = useRepos();
  const activity = useActivity();
  const library = useLibrary();
  const [q, setQ] = useState('');
  const [flow, setFlow] = useState<OpFlowConfig | null>(null);
  const [relocate, setRelocate] = useState<ProjectSummary | null>(null);
  const [unregister, setUnregister] = useState<ProjectSummary | null>(null);

  const list = projects.data ?? [];
  const live = list.filter((p) => p.exists);
  const missing = list.length - live.length;
  const totals = live.reduce((a, p) => ({ s: a.s + p.counts.skills, m: a.m + p.counts.mcp, p: a.p + p.counts.plugins }), { s: 0, m: 0, p: 0 });
  const counts = doctor.data?.counts ?? { error: 0, warn: 0, info: 0 };
  const dirty = (repos.data ?? []).filter((r) => r.dirty || r.ahead > 0);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    const toolHits = new Set((library.data ?? []).filter((i) => i.name.toLowerCase().includes(needle)).flatMap((i) => i.usedBy));
    return list.filter((p) => p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle) || toolHits.has(p.id));
  }, [q, list, library.data]);

  const fixableFor = (id: string) => (doctor.data?.issues ?? []).filter((i) => i.projectId === id && i.fixable);

  const installFlow = (targets: ProjectSummary[]): OpFlowConfig => ({
    eyebrow: targets.length === 1 ? `${targets[0]!.name} · 按清单还原` : `${targets.length} 个项目 · 按清单还原`,
    title: <span className="mono ca">atm install</span>,
    run: async (dryRun, o) => {
      const out: WriteResult[] = [];
      for (const p of targets) out.push(await api.install(p.id, { dryRun, adopt: o.adopt, force: o.force, strict: o.strict }));
      return out;
    },
    writeOptions: ['strict', 'adopt', 'force'],
    footnote: 'install 是幂等的：只补齐缺失的软链与 Agent 配置，已经一致的文件不会被改写。',
  });

  const syncAll = () => {
    api.sync().catch((e: unknown) => toast.push({ tone: 'err', title: 'sync 失败', detail: (e as Error).message }));
  };

  return (
    <>
      <PageHeader
        cap={`${list.length} 个已注册项目 · ${config.data ? tildify(config.data.root) : '~/GitHub'}`}
        title="总览"
        actions={
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="ov-search" className="text-[12px] font-medium text-ink2">
                搜索
              </label>
              <input id="ov-search" type="search" className="input w-[220px]" placeholder="项目或工具" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button type="button" className="btn btn-g" onClick={syncAll}>
              全部 sync
            </button>
            <button type="button" className="btn btn-p" disabled={!live.length} onClick={() => setFlow(installFlow(live.filter((p) => p.initialized)))}>
              全部 install
            </button>
          </>
        }
      />

      {projects.error != null && <ErrorBox error={projects.error} />}

      <div className="rise d1 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Stat cap="项目" value={list.length} sub={missing ? `${missing} 个目录缺失` : '全部目录可用'} />
        <Stat cap="启用的工具" value={totals.s + totals.m + totals.p} sub={`Skill ${totals.s} · MCP ${totals.m} · 插件 ${totals.p}`} />
        <Link to="/doctor" className="glass lift flex flex-col gap-1 rounded-[16px] px-[18px] py-4 text-ink no-underline">
          <span className="cap">体检</span>
          <span className="mono text-[28px] font-semibold">
            {counts.error + counts.warn === 0 ? (
              <span style={{ color: 'var(--ok-ink)' }}>ok</span>
            ) : (
              <>
                <span style={{ color: 'var(--err-ink)' }}>{counts.error}</span>
                <span className="text-[13px] font-normal text-ink3"> error </span>
                <span style={{ color: 'var(--warn-ink)' }}>{counts.warn}</span>
                <span className="text-[13px] font-normal text-ink3"> warn</span>
              </>
            )}
          </span>
          <span className="text-[12px] text-accent-ink">查看详情 →</span>
        </Link>
        <Stat
          cap="共享仓库"
          value={repos.data?.length ?? '…'}
          sub={dirty.length ? `${dirty.map((r) => r.repo.split('/').pop()).join('、')} 有本地改动` : '全部与远端一致'}
        />
      </div>

      {projects.isLoading ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
          {shown.map((p, i) => {
            const delay = Math.min(5, i + 2);
            return p.exists ? (
              <ProjectCard
                key={p.id}
                p={p}
                featured={i === 0}
                delay={delay}
                fixable={fixableFor(p.id).length}
                onInstall={() => setFlow(installFlow([p]))}
                onFix={() => {
                  const ids = fixableFor(p.id).map((x) => x.id);
                  setFlow({
                    eyebrow: `${p.name} · 一键修复`,
                    title: <span>修复 {ids.length} 项</span>,
                    run: (dryRun) => api.fix(ids, { dryRun }),
                  });
                }}
              />
            ) : (
              <MissingCard key={p.id} p={p} delay={delay} onRelocate={() => setRelocate(p)} onRemove={() => setUnregister(p)} />
            );
          })}
          {!shown.length && <Empty className="glass rounded-[20px]">{q ? `没有匹配「${q}」的项目` : '还没有注册任何项目。在项目目录执行 atm init 即可。'}</Empty>}
        </div>
      )}

      <section className="glass rise d5 overflow-hidden rounded-[20px]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
          <h2 className="m-0 text-[16px] font-semibold">最近变更</h2>
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink3">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: conn === 'open' ? 'var(--ok)' : 'var(--warn)' }} />
            监听 .agents/ 与 Agent 配置
          </span>
        </div>
        {activity.isLoading && <Loading />}
        {activity.data?.length === 0 && <Empty>还没有变更记录。</Empty>}
        {activity.data?.slice(0, 8).map((e, i, arr) => <ActivityRow key={`${e.at}-${i}`} e={e} last={i === arr.length - 1} />)}
      </section>

      <OpFlow config={flow} onClose={() => setFlow(null)} />
      {relocate && <RelocateDialog project={relocate} onClose={() => setRelocate(null)} />}
      {unregister && <UnregisterDialog project={unregister} onClose={() => setUnregister(null)} />}
    </>
  );
}
