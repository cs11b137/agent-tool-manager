import { msg, useLocale } from '../lib/i18n';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api/context';
import { useActivity, useConfig, useDoctor, useProjects, useRepos } from '../api/queries';
import type { ActivityEntry, ProjectSummary, WriteResult } from '../api/types';
import { ContextBar, DoctorChip, Empty, ErrorBox, KindChip, Loading, PageHeader, Rich } from '../components/ui';
import { OpFlow, type OpFlowConfig } from '../components/flows';
import { RelocateDialog, UnregisterDialog } from '../components/dialogs';
import { useConnection } from '../components/LiveProvider';
import { useToast } from '../components/Toaster';
import { AGENT_LABEL, fmtTok, hhmm, tildify } from '../lib/format';

/** 项目表列宽：项目 / Agent / 上下文 / S/M/P / 状态 / 行尾动作 */
const ROW_GRID = 'minmax(150px,1.4fr) minmax(90px,.9fr) minmax(120px,1fr) 86px 84px 76px';
/** Link 只占前 5 列（动作按钮不能嵌在 a 里），内部网格与外层前 5 轨对齐 */
const ROW_LINK_GRID = 'minmax(150px,1.4fr) minmax(90px,.9fr) minmax(120px,1fr) 86px 84px';
const ROW_CLS = 'hover-row group grid min-h-[44px] items-center gap-3 border-t border-line px-[14px] py-2 text-ink no-underline';
const ACTS_CLS = 'flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';

function Stat({ cap, value, sub }: { cap: string; value: ReactNode; sub: ReactNode }) {
  useLocale();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="cap">{cap}</span>
      <span className="mono text-[22px] font-medium">{value}</span>
      <span className="text-[12px] text-ink3">{sub}</span>
    </div>
  );
}

function ActivityRow({ e, last }: { e: ActivityEntry; last: boolean }) {
  useLocale();
  return (
    <div className={`flex flex-wrap items-center gap-3 px-3.5 py-2.5 text-[12.5px] ${last ? '' : 'border-b border-line'}`}>
      <span className="mono w-[52px] text-[12px] text-ink3">{hhmm(e.at)}</span>
      {e.level === 'error' ? (
        <span className="st st-err">{msg('错误')}</span>
      ) : e.kind ? (
        <KindChip kind={e.kind} />
      ) : e.level === 'warn' ? (
        <span className="st st-warn">{msg('警告')}</span>
      ) : (
        <span className="st text-ink3">{msg('提示')}</span>
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
  useLocale();
  const api = useApi();
  const toast = useToast();
  const conn = useConnection();
  const projects = useProjects();
  const config = useConfig();
  const doctor = useDoctor();
  const repos = useRepos();
  const activity = useActivity();
  const [flow, setFlow] = useState<OpFlowConfig | null>(null);
  const [relocate, setRelocate] = useState<ProjectSummary | null>(null);
  const [unregister, setUnregister] = useState<ProjectSummary | null>(null);

  const list = projects.data ?? [];
  const live = list.filter((p) => p.exists);
  const missing = list.length - live.length;
  const totals = live.reduce((a, p) => ({ s: a.s + p.counts.skills, m: a.m + p.counts.mcp, p: a.p + p.counts.plugins }), { s: 0, m: 0, p: 0 });
  const ctxTotal = live.reduce((a, p) => a + p.context.total, 0);
  const counts = doctor.data?.counts ?? { error: 0, warn: 0, info: 0 };
  const dirty = (repos.data ?? []).filter((r) => r.dirty || r.ahead > 0);

  const fixableFor = (id: string) => (doctor.data?.issues ?? []).filter((i) => i.projectId === id && i.fixable);

  const installFlow = (targets: ProjectSummary[]): OpFlowConfig => ({
    eyebrow: targets.length === 1 ? msg("{0} · 按清单还原", {0: targets[0]!.name}) : msg("{0} 个项目 · 按清单还原", {0: targets.length}),
    title: <span className="mono">atm install</span>,
    run: async (dryRun, o) => {
      const out: WriteResult[] = [];
      for (const p of targets) out.push(await api.install(p.id, { dryRun, adopt: o.adopt, force: o.force, strict: o.strict }));
      return out;
    },
    writeOptions: ['strict', 'adopt', 'force'],
    footnote: msg("install 是幂等的：只补齐缺失的软链与 Agent 配置，已经一致的文件不会被改写。"),
  });

  const syncAll = () => {
    api.sync().catch((e: unknown) => toast.push({ tone: 'err', title: msg("sync 失败"), detail: (e as Error).message }));
  };

  return (
    <>
      <PageHeader
        cap={msg("{0} 个已注册项目 · {1}", {0: list.length, 1: config.data ? tildify(config.data.root) : '~/.agent-tools'})}
        title={msg("总览")}
        actions={
          <>
            <button type="button" className="btn btn-g" onClick={syncAll}>
              {msg("全部 sync")}</button>
            <button type="button" className="btn btn-p" disabled={!live.length} onClick={() => setFlow(installFlow(live.filter((p) => p.initialized)))}>
              {msg("全部 install")}</button>
          </>
        }
      />

      {projects.error != null && <ErrorBox error={projects.error} />}

      <div className="statbar" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
        <Stat cap={msg("项目")} value={list.length} sub={missing ? msg("{0} 个目录缺失", {0: missing}) : !list.length ? msg("添加项目后显示状态") : msg("全部目录可用")} />
        <Stat
          cap={msg("启用的工具")}
          value={totals.s + totals.m + totals.p}
          sub={`${msg("Skill {0} · MCP {1} · 插件 {2}", {0: totals.s, 1: totals.m, 2: totals.p})} · Σ≈${fmtTok(ctxTotal)}`}
        />
        <Link to="/doctor" className="flex min-w-0 flex-col gap-1 text-ink no-underline">
          <span className="cap">{msg("体检")}</span>
          <span className="mono text-[22px] font-medium">
            {!doctor.data ? (
              <span className="text-ink3">{doctor.error ? msg('检查失败') : msg('检查中…')}</span>
            ) : counts.error + counts.warn === 0 ? (
              <span style={{ color: doctor.data.projects.length ? 'var(--ok-ink)' : 'var(--ink3)' }}>{doctor.data.projects.length ? msg('正常') : msg('暂无项目')}</span>
            ) : (
              <>
                <span style={{ color: 'var(--err-ink)' }}>{counts.error}</span>
                <span className="text-[13px] font-normal text-ink3">{msg('项错误')} </span>
                <span style={{ color: 'var(--warn-ink)' }}>{counts.warn}</span>
                <span className="text-[13px] font-normal text-ink3">{msg('项警告')}</span>
              </>
            )}
          </span>
          <span className="text-[12px] text-accent-ink">{msg("查看详情 →")}</span>
        </Link>
        <Stat
          cap={msg("已导入仓库")}
          value={repos.data?.length ?? '…'}
          sub={dirty.length ? msg("{0} 有本地改动", {0: dirty.map((r) => r.repo.split('/').pop()).join('、')}) : !repos.data?.length ? msg("还没有导入仓库") : msg("全部与远端一致")}
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {projects.isLoading ? (
          <Loading />
        ) : !list.length ? (
          <Empty className="glass rounded-[8px]">{<><strong className="block text-ink">{msg("共享仓库已就绪")}</strong><span className="mt-2 block">{msg("先在工具库新建工具，再添加项目目录并关联。")}</span><Link className="btn btn-p mt-4" to="/library">{msg("前往工具库")}</Link></>}</Empty>
        ) : (
          <section className="tbl">
            <div className="tbl-head grid min-h-[32px] items-center gap-3 border-b border-line px-[14px] py-2" style={{ gridTemplateColumns: ROW_GRID }}>
              <span>{msg("项目")}</span>
              <span>Agent</span>
              <span>{msg("常驻上下文")}</span>
              <span className="text-right">S/M/P</span>
              <span>{msg("状态")}</span>
              <span />
            </div>
            {list.map((p) => {
              if (!p.exists) {
                return (
                  <div key={p.id} className={ROW_CLS} style={{ gridTemplateColumns: ROW_GRID }}>
                    <span className="min-w-0">
                      <h2 className="m-0 truncate text-[13px] font-medium text-ink3 line-through">{p.name}</h2>
                      <span className="mono block break-all text-[11px] text-ink4">{tildify(p.path)}</span>
                    </span>
                    <span className="flex min-w-0 gap-1 overflow-hidden">
                      <span className="chip c-muted shrink-0">{msg("目录不存在")}</span>
                    </span>
                    <span className="text-[12px] text-ink3">—</span>
                    <span className="mono text-right text-[12px] text-ink3">0 / 0 / 0</span>
                    <span />
                    <span className={ACTS_CLS}>
                      <button type="button" className="btn btn-t btn-sm" onClick={() => setRelocate(p)}>
                        {msg("重新定位…")}</button>
                      <button type="button" className="btn btn-t btn-sm text-err-ink" onClick={() => setUnregister(p)}>
                        {msg("从注册表移除")}</button>
                    </span>
                  </div>
                );
              }
              const c = p.counts;
              const fixable = fixableFor(p.id).length;
              return (
                <div key={p.id} className={ROW_CLS} style={{ gridTemplateColumns: ROW_GRID }}>
                  <Link
                    to={`/projects/${p.id}`}
                    className="grid min-w-0 items-center gap-3 text-ink no-underline"
                    style={{ gridColumn: '1 / 6', gridTemplateColumns: ROW_LINK_GRID }}
                  >
                    <span className="min-w-0">
                      <h2 className="m-0 truncate text-[13px] font-medium">{p.name}</h2>
                      <span className="mono block break-all text-[11px] text-ink4">{tildify(p.path)}</span>
                    </span>
                    <span className="flex min-w-0 gap-1 overflow-hidden">
                      {p.agents.map((a) => (
                        <span key={a} className="chip c-agent shrink-0">
                          {AGENT_LABEL[a]}
                        </span>
                      ))}
                      {!p.initialized && <span className="chip c-muted shrink-0">{msg("未初始化")}</span>}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-[72px] shrink-0">
                        <ContextBar context={p.context} height={6} />
                      </span>
                      <span className="mono truncate text-[12px] text-ink3">
                        ≈{fmtTok(p.context.total)}
                        {p.context.unmeasured > 0 && ' +?'}
                      </span>
                    </span>
                    <span className="mono text-right text-[12px] text-ink3">{`${c.skills} / ${c.mcp} / ${c.plugins}`}</span>
                    <span className="min-w-0 overflow-hidden">
                      <DoctorChip counts={p.doctor} />
                    </span>
                  </Link>
                  <span className={ACTS_CLS}>
                    {fixable > 0 ? (
                      <button
                        type="button"
                        className="btn btn-g btn-sm"
                        onClick={() => {
                          const ids = fixableFor(p.id).map((x) => x.id);
                          setFlow({
                            eyebrow: msg("{0} · 一键修复", {0: p.name}),
                            title: <span>{msg("修复 {0} 项", {0: ids.length})}</span>,
                            run: (dryRun) => api.fix(ids, { dryRun }),
                          });
                        }}
                      >
                        {msg("修复断链")}</button>
                    ) : (
                      <button type="button" className="btn btn-g btn-sm" onClick={() => setFlow(installFlow([p]))}>
                        {msg('还原工具')}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </section>
        )}

        <section className="glass overflow-hidden rounded-[8px]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3.5 py-3">
            <h2 className="m-0 text-[13px] font-semibold">{msg("最近变更")}</h2>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-ink3">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: conn === 'open' ? 'var(--ok)' : 'var(--warn)' }} />
              {msg("监听 .agents/ 与 Agent 配置")}</span>
          </div>
          {activity.isLoading && <Loading />}
          {activity.data?.length === 0 && <Empty>{msg("还没有变更记录。")}</Empty>}
          {activity.data?.slice(0, 8).map((e, i, arr) => <ActivityRow key={`${e.at}-${i}`} e={e} last={i === arr.length - 1} />)}
        </section>
      </div>

      <OpFlow config={flow} onClose={() => setFlow(null)} />
      {relocate && <RelocateDialog project={relocate} onClose={() => setRelocate(null)} />}
      {unregister && <UnregisterDialog project={unregister} onClose={() => setUnregister(null)} />}
    </>
  );
}
