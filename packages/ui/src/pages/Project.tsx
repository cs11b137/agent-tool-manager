import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useApi } from '../api/context';
import { qk, useConfig, useProject } from '../api/queries';
import type { AgentId, BatchOp, DoctorIssue, ProjectDetail, ToolEntry, ToolKind } from '../api/types';
import { ALL_AGENTS } from '../api/types';
import { ContextBar, ContextLegend, Empty, ErrorBox, KindChip, LevelGlyph, Loading, PendingBar, Rich, Switch } from '../components/ui';
import { AddToolFlow, OpFlow, agentsRun, type OpFlowConfig } from '../components/flows';
import { Dialog } from '../components/Dialog';
import { DiffTabs } from '../components/DiffView';
import { RelocateDialog, UnregisterDialog } from '../components/dialogs';
import { useToast } from '../components/Toaster';
import { useAcknowledged } from '../lib/ack';
import { AGENT_LABEL, AGENT_MCP_FILE, agentsLabel, displayName, fmtTok, shortHash, tildify } from '../lib/format';

function sourceLine(t: ToolEntry): string {
  if (t.kind === 'mcp' && t.mcp) {
    let tail = t.mcp.command ?? '';
    if (!tail && t.mcp.url) {
      try {
        tail = new URL(t.mcp.url).host;
      } catch {
        tail = t.mcp.url;
      }
    }
    return [t.mcp.origin, t.mcp.transport, tail].filter(Boolean).join(' · ');
  }
  return t.source;
}

function revChip(t: ToolEntry): { text: string; tone?: 'err' } {
  if (t.kind === 'skill' && t.skill) return { text: t.skill.rev ? `rev ${t.skill.rev}` : t.skill.commit.slice(0, 7) };
  if (t.kind === 'mcp' && t.mcp) return { text: shortHash(t.mcp.hash) };
  if (t.plugin) return t.plugin.installed ? { text: '已安装' } : { text: '未安装', tone: 'err' };
  return { text: '' };
}

/** Banner copy per issue (prototype 02 shows the mcp-dup-plugin warn). */
function bannerText(i: DoctorIssue): string {
  if (i.code === 'mcp-dup-plugin' && i.name) {
    const plugin = /`([^`]+@[^`]+)`/.exec(i.detail ?? '')?.[1];
    if (plugin) return `MCP \`${i.name}\` 与插件 \`${plugin}\` 自带的 MCP 同名，Agent 中会出现两份工具定义。`;
  }
  if (i.code === 'broken-link' && i.detail) return `断链 · \`${i.detail.split(' → ')[0]}\` 的目标不存在，执行 install 可以重建。`;
  return `${i.kind ? `${i.kind === 'mcp' ? 'MCP' : i.kind === 'skill' ? 'Skill' : '插件'} ` : ''}${i.name ? `\`${displayName(i.kind ?? 'skill', i.name)}\` ` : ''}${i.title}`;
}

function ToolRow({ t, on, onToggle }: { t: ToolEntry; on: boolean; onToggle: () => void }) {
  const chip = revChip(t);
  const name = displayName(t.kind, t.name);
  return (
    <div className="hover-row flex gap-3.5 border-b border-line px-[18px] py-4" style={{ opacity: on ? 1 : 0.5 }}>
      <Switch checked={on} onChange={onToggle} label={`启用 ${name}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex justify-between gap-2">
          <span className="mono truncate text-[14px] font-medium">{name}</span>
          <span className="mono text-[13px] font-semibold">{t.contextTokens === null ? '?' : fmtTok(t.contextTokens)}</span>
        </div>
        <span className="mono truncate text-[12px] text-ink3">{sourceLine(t)}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="chip font-medium" style={chip.tone === 'err' ? { background: 'var(--err-soft)', color: 'var(--err-ink)' } : { background: 'var(--line)', color: 'var(--ink2)' }}>
            {chip.text}
          </span>
          {t.skill?.broken && (
            <span className="chip" style={{ background: 'var(--err-soft)', color: 'var(--err-ink)' }}>
              断链
            </span>
          )}
          {t.mcp?.envVars.some((v) => !v.set) && (
            <span className="chip" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }} title={t.mcp.envVars.filter((v) => !v.set).map((v) => v.name).join(', ')}>
              变量未设置
            </span>
          )}
          <span className="text-[12px] text-ink2">{agentsLabel(t.agents)}</span>
        </div>
      </div>
    </div>
  );
}

function Column({
  kind,
  title,
  tools,
  off,
  onToggle,
  onAdd,
  footer,
  flex,
  delay,
}: {
  kind: ToolKind;
  title: string;
  tools: ToolEntry[];
  off: Set<string>;
  onToggle: (t: ToolEntry) => void;
  onAdd: () => void;
  footer: ReactNode;
  flex: string;
  delay: number;
}) {
  return (
    <section className={`glass rise d${delay} min-w-0 overflow-hidden rounded-[20px]`} style={{ flex }}>
      <div className="flex items-center gap-2.5 border-b border-line px-[18px] py-4">
        <KindChip kind={kind} />
        <h2 className="m-0 text-[16px] font-semibold">{title}</h2>
        <span className="mono text-[13px] text-ink3">{tools.length}</span>
        <button type="button" className="ml-auto border-0 bg-transparent p-0 text-[14px] font-medium text-accent-ink hover:underline" onClick={onAdd}>
          + 添加
        </button>
      </div>
      {tools.length === 0 && <Empty className="border-b border-line">还没有{title}。</Empty>}
      {tools.map((t) => (
        <ToolRow key={t.name} t={t} on={!off.has(`${t.kind}:${t.name}`)} onToggle={() => onToggle(t)} />
      ))}
      <p className="m-0 px-[18px] py-3 text-[12px] leading-[1.5] text-ink3">{footer}</p>
    </section>
  );
}

function GeneratedDialog({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const api = useApi();
  const id = useId();
  const q = useQuery({ queryKey: qk.generated(project.id), queryFn: () => api.getGenerated(project.id) });
  const files = useMemo(() => {
    const data = q.data ?? [];
    // keep unchanged files (diff empty) — DiffTabs shows their content
    return data.map((c) => ({ key: c.path, label: c.relPath.startsWith('.agents/') && c.type === 'file' ? c.relPath.slice(8) : c.relPath, change: c }));
  }, [q.data]);
  const drift = (q.data ?? []).filter((c) => c.additions + c.deletions > 0).length;
  return (
    <Dialog open onClose={onClose} labelledBy={id}>
      <header className="flex flex-wrap items-center gap-4 border-b border-line px-[26px] py-[22px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="cap">{project.name} · 清单渲染结果 vs 磁盘</span>
          <h1 id={id} className="m-0 text-[24px] font-bold">
            查看生成的配置
          </h1>
        </div>
        <span
          className="chip"
          style={drift ? { background: 'var(--warn-soft)', color: 'var(--warn-ink)' } : { background: 'var(--ok-soft)', color: 'var(--ok-ink)' }}
        >
          {drift ? `${drift} 个文件与清单不一致` : '与磁盘一致'}
        </span>
        <button type="button" aria-label="关闭" className="btn btn-t btn-lg !w-11 !p-0" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </header>
      <div className="flex flex-col gap-3.5 px-[26px] py-[22px]">
        {q.isLoading && <Loading className="!px-0" />}
        {q.error != null && <ErrorBox error={q.error} />}
        {files.length > 0 && <DiffTabs files={files} initial={0} />}
        <p className="m-0 text-[12px] leading-[1.6] text-ink3">只读视图。一致的文件显示完整内容；不一致的显示 diff，执行 install 即可还原。</p>
      </div>
    </Dialog>
  );
}

export function ProjectPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const toast = useToast();
  const config = useConfig();
  const { data: p, error, isLoading } = useProject(id);
  const { ids: acked } = useAcknowledged();
  const [off, setOff] = useState<Set<string>>(new Set());
  const [flow, setFlow] = useState<OpFlowConfig | null>(null);
  const [adding, setAdding] = useState<ToolKind | null>(null);
  const [showGenerated, setShowGenerated] = useState(false);
  const [relocate, setRelocate] = useState(false);
  const [unregister, setUnregister] = useState(false);

  if (isLoading) return <Loading />;
  if (error || !p) return <ErrorBox error={error ?? new Error('项目不存在')} />;

  const crumb = (
    <span className="text-[13px] text-ink3">
      <Link to="/" className="text-ink3">
        总览
      </Link>{' '}
      / 项目
    </span>
  );

  if (!p.exists) {
    return (
      <>
        <div className="rise flex flex-col gap-1.5">
          {crumb}
          <h1 className="mono m-0 text-[36px] font-bold tracking-[-0.02em] text-ink3 line-through">{p.name}</h1>
          <span className="mono text-[12px] text-ink3">{tildify(p.path)}</span>
        </div>
        <section className="rise d1 flex flex-col gap-4 rounded-[20px] p-[22px]" style={{ border: '1.5px dashed var(--line2)', background: 'repeating-linear-gradient(135deg, var(--glass-2) 0 8px, transparent 8px 16px)' }}>
          <span className="chip c-muted self-start font-sans">目录不存在</span>
          <p className="m-0 max-w-[60ch] text-[14px] leading-[1.6] text-ink2">注册表里还记着这个项目，但目录已经找不到了。只是移动了位置的话可以重新定位；否则从注册表移除，不会删除任何文件。</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-g" onClick={() => setRelocate(true)}>
              重新定位…
            </button>
            <button type="button" className="btn btn-d" onClick={() => setUnregister(true)}>
              从注册表移除
            </button>
          </div>
        </section>
        {relocate && <RelocateDialog project={p} onClose={() => setRelocate(false)} />}
        {unregister && <UnregisterDialog project={p} onClose={() => setUnregister(false)} />}
      </>
    );
  }

  const key = (t: ToolEntry) => `${t.kind}:${t.name}`;
  const toggle = (t: ToolEntry) =>
    setOff((s) => {
      const n = new Set(s);
      if (n.has(key(t))) n.delete(key(t));
      else n.add(key(t));
      return n;
    });
  const byKind = (k: ToolKind) => p.tools.filter((t) => t.kind === k);
  const active = p.tools.filter((t) => !off.has(key(t)));
  const sum = (k: ToolKind) => active.filter((t) => t.kind === k).reduce((s, t) => s + (t.contextTokens ?? 0), 0);
  const ctx = { skill: sum('skill'), mcp: sum('mcp'), plugin: sum('plugin'), total: 0, unmeasured: active.filter((t) => t.contextTokens === null).length };
  ctx.total = ctx.skill + ctx.mcp + ctx.plugin;

  const pending = p.tools.filter((t) => off.has(key(t)));
  const banners = p.issues.filter((i) => (i.level === 'error' || i.level === 'warn') && !acked.includes(i.id));
  const mcpFiles = p.agents.map((a) => AGENT_MCP_FILE[a]);

  const applyPending = () => {
    const ops: BatchOp[] = pending.map((t) => ({ projectId: p.id, action: 'remove', spec: { kind: t.kind, name: t.name } }));
    setFlow({
      eyebrow: `${p.name} · 批量改动`,
      title: <span>{ops.length} 项改动</span>,
      run: (dryRun) => api.batch(ops, { dryRun }),
      onCommitted: () => setOff(new Set()),
    });
  };

  const changeAgents = (a: AgentId) => {
    const next = p.agents.includes(a) ? p.agents.filter((x) => x !== a) : ALL_AGENTS.filter((x) => x === a || p.agents.includes(x));
    if (!next.length) {
      toast.push({ tone: 'err', title: '至少保留一个 Agent' });
      return;
    }
    setFlow({
      eyebrow: `${p.name} · 落地到 Agent`,
      title: <span className="text-[20px]">{next.map((x) => AGENT_LABEL[x]).join(' · ')}</span>,
      run: (dryRun) => agentsRun(api, p.id, next, dryRun),
    });
  };

  const install = () =>
    setFlow({
      eyebrow: `${p.name} · 按清单还原`,
      title: <span className="mono ca">atm install</span>,
      run: (dryRun) => api.install(p.id, { dryRun }),
      footnote: 'install 是幂等的：只补齐缺失的软链与 Agent 配置，已经一致的文件不会被改写。',
    });

  const measure = () => {
    api.getDoctor(p.id, { measure: true }).catch((e: unknown) => toast.push({ tone: 'err', title: 'doctor --measure 失败', detail: (e as Error).message }));
  };

  return (
    <>
      <div className="rise flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          {crumb}
          <h1 className="mono ca m-0 text-[36px] font-bold tracking-[-0.02em]">{p.name}</h1>
          <span className="mono text-[12px] text-ink3">
            {tildify(p.path)} · {p.initialized ? '.agents/tools.json' : '未初始化'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-g" disabled={!p.initialized} onClick={() => setShowGenerated(true)}>
            查看生成的配置
          </button>
          <button type="button" className="btn btn-g" disabled={!p.initialized} onClick={measure}>
            doctor --measure
          </button>
          <button type="button" className="btn btn-p" disabled={!p.initialized} onClick={install}>
            install
          </button>
        </div>
      </div>

      {!p.initialized ? (
        <section className="glass iri rise d1 flex flex-wrap items-center gap-4 rounded-[20px] px-6 py-[22px]" style={{ background: 'var(--glass-strong)' }}>
          <div className="flex flex-[1_1_320px] flex-col gap-1">
            <strong className="text-[16px]">这个目录还没有 atm 清单</strong>
            <span className="text-[13px] leading-[1.6] text-ink2">
              atm init 会创建 <code className="mono">.agents/tools.json</code>、<code className="mono">.agents/skills/</code> 和各 Agent 的入口软链，并更新 .gitignore。
            </span>
          </div>
          <button
            type="button"
            className="btn btn-p"
            onClick={() =>
              setFlow({ eyebrow: `${p.name} · 初始化`, title: <span className="mono ca">atm init</span>, run: (dryRun) => api.initProject(p.id, { dryRun }) })
            }
          >
            atm init
          </button>
        </section>
      ) : (
        <>
          <section className="glass iri rise d1 flex flex-wrap items-center gap-8 rounded-[20px] px-6 py-[22px]" style={{ background: 'var(--glass-strong)' }}>
            <div className="flex flex-[7_1_360px] flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <span className="cap">常驻上下文</span>
                <span className="mono ca text-[32px] font-semibold">
                  ≈ {fmtTok(ctx.total)}
                  {ctx.unmeasured > 0 && ' + ?'}{' '}
                  <span className="text-[13px] font-normal text-ink3" style={{ textShadow: 'none' }}>
                    / 10k tokens
                  </span>
                </span>
              </div>
              <ContextBar context={ctx} height={12} />
              <ContextLegend context={ctx} />
            </div>
            <fieldset className="m-0 flex flex-[5_1_280px] flex-col gap-2.5 border-0 p-0">
              <legend className="cap pb-2.5">落地到 Agent</legend>
              <div className="flex flex-wrap gap-2">
                {ALL_AGENTS.map((a) => {
                  const on = p.agents.includes(a);
                  return (
                    <label key={a} className={`agt ${on ? '' : 'off'}`}>
                      <input type="checkbox" checked={on} onChange={() => changeAgents(a)} />
                      {AGENT_LABEL[a]}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </section>

          {banners.map((i) => (
            <div
              key={i.id}
              role="status"
              className="glass rise d2 flex flex-wrap items-center gap-3 rounded-[14px] px-4 py-3 text-[14px] leading-[1.5]"
              style={{ background: i.level === 'error' ? 'var(--err-soft)' : 'var(--warn-soft)' }}
            >
              <LevelGlyph level={i.level} size={9} />
              <span className="flex-[1_1_300px]">
                <strong style={{ color: i.level === 'error' ? 'var(--err-ink)' : 'var(--warn-ink)' }}>{i.level}</strong> · <Rich text={bannerText(i)} />
              </span>
              <Link to="/doctor" className="font-semibold" style={{ color: i.level === 'error' ? 'var(--err-ink)' : 'var(--warn-ink)' }}>
                去体检处理 →
              </Link>
            </div>
          ))}

          <div className="flex flex-wrap items-start gap-4">
            <Column
              kind="skill"
              title="Skills"
              tools={byKind('skill')}
              off={off}
              onToggle={toggle}
              onAdd={() => setAdding('skill')}
              flex="4 1 280px"
              delay={3}
              footer={
                <>
                  软链到 <code className="mono">{config.data ? tildify(config.data.root) : '~/GitHub'}</code>，所有 Agent 共用 .agents/skills
                </>
              }
            />
            <Column
              kind="mcp"
              title="MCP"
              tools={byKind('mcp')}
              off={off}
              onToggle={toggle}
              onAdd={() => setAdding('mcp')}
              flex="5 1 300px"
              delay={4}
              footer={`渲染到 ${mcpFiles.join(' 与 ')}，只改动 atm 管理的条目`}
            />
            <Column
              kind="plugin"
              title="插件"
              tools={byKind('plugin')}
              off={off}
              onToggle={toggle}
              onAdd={() => setAdding('plugin')}
              flex="3 1 260px"
              delay={5}
              footer="写入 .claude/settings.json 的 enabledPlugins，只对 Claude Code 生效"
            />
          </div>

          {pending.length > 0 && (
            <PendingBar label={`${pending.length} 项改动待提交`} sub="尚未写入任何文件" onReset={() => setOff(new Set())} onApply={applyPending} applyLabel="查看 diff 并应用" />
          )}
        </>
      )}

      <OpFlow config={flow} onClose={() => setFlow(null)} />
      {adding && <AddToolFlow onClose={() => setAdding(null)} projectIds={[p.id]} kind={adding} />}
      {showGenerated && <GeneratedDialog project={p} onClose={() => setShowGenerated(false)} />}
    </>
  );
}

