import { msg, useLocale } from '../lib/i18n';
import { useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useApi } from '../api/context';
import { useLibrary, useProjects } from '../api/queries';
import { ApiError, isWriteResult } from '../api/client';
import type { AddSpec, AgentId, BatchResult, LibraryItem, MigrateSpec, ProjectSummary, ToolKind, WriteResult } from '../api/types';
import { ALL_AGENTS } from '../api/types';
import { fromBatch, fromWriteResults, type WritePreview } from '../lib/changes';
import { AGENT_LABEL, AGENT_MCP_FILE, KIND_TITLE, displayName, fmtTok, fmtTokShort } from '../lib/format';
import { WriteFlow, type WriteOpts } from './WriteFlow';
import { KindChip, LevelGlyph, Switch } from './ui';
import { useToast } from './Toaster';

type RunResult = WriteResult | WriteResult[] | BatchResult;

function normalize(r: RunResult, projects: ProjectSummary[]): WritePreview {
  if (Array.isArray(r)) return fromWriteResults(r, projects);
  if ('results' in r) return fromBatch(r, projects);
  return fromWriteResults([r], projects);
}

export interface OpFlowConfig {
  eyebrow: string;
  title: ReactNode;
  /** called with dryRun=true for the preview, then dryRun=false on confirm */
  run: (dryRun: boolean, o: WriteOpts) => Promise<RunResult>;
  /** CLI flags to offer on the preview step */
  writeOptions?: Array<keyof WriteOpts>;
  aside?: ReactNode;
  footnote?: ReactNode;
  onCommitted?: () => void;
}

/** WriteFlow for operations whose selection already happened (batch, fix, install, remove, agents). */
export function OpFlow({ config, onClose }: { config: OpFlowConfig | null; onClose: () => void }) {
  useLocale();
  const { data: projects = [] } = useProjects();
  if (!config) return null;
  return (
    <WriteFlow
      open
      onClose={onClose}
      eyebrow={config.eyebrow}
      title={config.title}
      aside={config.aside}
      footnote={config.footnote}
      {...(config.writeOptions ? { writeOptions: config.writeOptions } : {})}
      preview={async (o) => normalize(await config.run(true, o), projects)}
      commit={(o) => config.run(false, o)}
      {...(config.onCommitted ? { onCommitted: config.onCommitted } : {})}
    />
  );
}

/** Helper for PATCH agents → WriteResult (dryRun) */
export async function agentsRun(api: ReturnType<typeof useApi>, id: string, agents: AgentId[], dryRun: boolean): Promise<WriteResult> {
  const r = await api.patchProject(id, { agents }, { dryRun });
  return isWriteResult(r) ? r : { applied: true, files: [], warnings: [] };
}

export function specFor(item: LibraryItem, agents?: AgentId[], rev?: string): AddSpec {
  if (item.kind === 'skill') return { kind: 'skill', repo: item.skill?.repo ?? item.source, name: item.name, ...(rev ? { rev } : {}) };
  if (item.kind === 'mcp') return { kind: 'mcp', name: item.name, ...(agents ? { agents } : {}) };
  return { kind: 'plugin', name: item.name };
}

function DefinitionBlock({ item }: { item: LibraryItem }) {
  useLocale();
  const rows: Array<[string, string]> = [];
  if (item.kind === 'mcp' && item.mcp) {
    rows.push(['transport', item.mcp.transport]);
    if (item.detail) rows.push([item.mcp.transport === 'http' ? 'url' : 'command', item.mcp.transport === 'http' ? item.detail : item.detail.split(' · ').pop() ?? item.detail]);
    rows.push([msg("来源"), item.mcp.origin]);
  } else if (item.kind === 'skill' && item.skill) {
    rows.push(['repo', item.skill.repo], ['path', item.skill.path], ['commit', item.skill.commit.slice(0, 7)]);
  } else if (item.plugin) {
    rows.push(['marketplace', item.plugin.marketplace], [msg("状态"), item.plugin.installed ? msg("已安装{0}", {0: item.plugin.version ? ` · v${item.plugin.version}` : ''}) : item.plugin.localSource ? msg("本地源码 · 在 Claude Code 中信任项目后加载") : msg("未安装")]);
  }
  const heading =
    item.kind === 'mcp' ? msg("定义 · {0}/{1}.json", {0: item.mcp?.origin === 'project' ? 'project' : 'registry', 1: item.name}) : item.kind === 'skill' ? msg("来源 · {0}", {0: item.source}) : item.plugin?.localSource ? msg("插件 · 共享仓库") : msg("插件 · installed_plugins.json");
  return (
    <div className="flex flex-col gap-2.5">
      <h2 className="cap m-0">{heading}</h2>
      {item.description && <p className="m-0 text-[13px] leading-[1.6] text-ink2">{item.description}</p>}
      <dl className="m-0 grid grid-cols-[84px_1fr] gap-y-2.5 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink3">{k}</dt>
            <dd className="mono m-0 break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EnvBlock({ item }: { item: LibraryItem }) {
  useLocale();
  const vars = item.mcp?.envVars ?? [];
  if (!vars.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <h2 className="cap m-0">{msg("环境变量")}</h2>
      {vars.map((v) => (
        <div key={v.name} className="flex min-h-11 items-center gap-2 rounded-[12px] px-3.5" style={{ background: v.set ? 'var(--ok-soft)' : 'var(--warn-soft)' }}>
          <span className="mono text-[13px]">{v.name}</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: v.set ? 'var(--ok-ink)' : 'var(--warn-ink)' }}>
            {v.set ? <LevelGlyph level="ok" size={6} /> : <LevelGlyph level="warn" size={6} />}
            {v.set ? msg("已设置") : msg("未设置")}
          </span>
        </div>
      ))}
      <p className="m-0 text-[12px] leading-[1.6] text-ink3">{msg("只引用变量，配置文件不含密钥值，可以安全提交。")}</p>
    </div>
  );
}

/** Candidate picker used on step 1 when adding from the project page. */
function ToolPicker({ items, value, onChange, kind }: { items: LibraryItem[]; value: string | null; onChange: (key: string) => void; kind?: ToolKind }) {
  useLocale();
  const [q, setQ] = useState('');
  const shown = items.filter((i) => !q || `${i.name} ${i.source} ${i.description ?? ''} ${i.detail ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="label">{msg("搜索 {0}", {0: kind ? msg(KIND_TITLE[kind]) : msg("工具")})}</span>
        <span className="relative">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink3" aria-hidden />
          <input data-autofocus className="input input-lg w-full !pl-10" type="search" placeholder={msg("按名称、仓库或描述搜索")} value={q} onChange={(e) => setQ(e.target.value)} />
        </span>
      </label>
      <div role="radiogroup" aria-label={msg("选择工具")} className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
        {shown.length === 0 && <p className="m-0 py-4 text-[13px] text-ink3">{msg("没有可添加的 {0}。请先在工具库导入仓库或新建工具。", {0: kind ? msg(KIND_TITLE[kind]) : msg("工具")})}</p>}
        {shown.map((i) => {
          const key = `${i.kind}:${i.name}`;
          const on = key === value;
          return (
            <label key={key} className="agt tall !items-center" style={on ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}>
              <input type="radio" name="tool" checked={on} onChange={() => onChange(key)} />
              <KindChip kind={i.kind} />
              <span className="flex min-w-0 flex-col py-2">
                <span className="mono truncate text-[14px]">{displayName(i.kind, i.name)}</span>
                <span className="truncate text-[12px] font-normal text-ink3">{i.description ?? i.detail ?? i.source}</span>
              </span>
              <span className="mono ml-auto text-[13px] font-semibold">{fmtTokShort(i.contextTokens)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 添加工具：from project detail (single project, step 1 = pick a tool) or from library (preselected tool, several projects).
 */
export function AddToolFlow({
  onClose,
  projectIds,
  item: preset,
  kind,
}: {
  onClose: () => void;
  projectIds: string[];
  item?: LibraryItem;
  kind?: ToolKind;
}) {
  useLocale();
  const api = useApi();
  const toast = useToast();
  const { data: projects = [] } = useProjects();
  const { data: library = [] } = useLibrary({ includeInstalledPlugins: true });
  const targets = projects.filter((p) => projectIds.includes(p.id));
  const single = targets.length === 1 ? targets[0]! : null;
  const [picked, setPicked] = useState<string | null>(preset ? `${preset.kind}:${preset.name}` : null);
  const item = preset ?? library.find((i) => `${i.kind}:${i.name}` === picked);
  const [agents, setAgents] = useState<AgentId[] | null>(null);
  const [rev, setRev] = useState('');
  const effAgents = agents ?? single?.agents ?? [];

  const candidates = useMemo(
    () => library.filter((i) => (!kind || i.kind === kind) && !(single && i.usedBy.includes(single.id))),
    [library, kind, single],
  );

  // Only pass `agents` when the user narrowed the selection: otherwise the manifest gets `{ name, agents }`
  // instead of the plain `"name"` that `atm add mcp <name>` writes.
  const narrowed = !!single && agents !== null && !(effAgents.length === single.agents.length && single.agents.every((a) => effAgents.includes(a)));
  const spec = item ? specFor(item, item.kind === 'mcp' && narrowed ? effAgents : undefined, rev.trim() || undefined) : null;
  const previewKey = JSON.stringify([spec, projectIds]);

  const eyebrow = msg("{0} · 添加工具", {0: targets.length === 1 ? single!.name : `${targets.length} 个项目`});
  const title = item ? (
    <>
      <KindChip kind={item.kind} />
      <span className="mono ca">{displayName(item.kind, item.name)}</span>
    </>
  ) : (
    <>
      {kind && <KindChip kind={kind} />}
      <span>{msg("选择要添加的 {0}", {0: kind ? msg(KIND_TITLE[kind]) : msg("工具")})}</span>
    </>
  );

  const before = single?.context.total ?? 0;
  const aside = item && (
    <>
      <DefinitionBlock item={item} />
      {item.kind === 'mcp' && single && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="cap pb-2.5">{msg("写入到")}</legend>
          {ALL_AGENTS.map((a) => {
            const enabled = single.agents.includes(a);
            const on = enabled && effAgents.includes(a);
            return (
              <label key={a} className={`agt tall ${enabled ? '' : 'disabled'}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!enabled || (on && effAgents.length === 1)}
                  onChange={() => setAgents(on ? effAgents.filter((x) => x !== a) : ALL_AGENTS.filter((x) => x === a || effAgents.includes(x)))}
                />
                {AGENT_LABEL[a]}
                {enabled ? (
                  <code className="mono ml-auto text-[12px] font-normal text-ink3">{AGENT_MCP_FILE[a]}</code>
                ) : (
                  <span className="ml-auto text-[12px] font-normal">{msg("项目未启用")}</span>
                )}
              </label>
            );
          })}
        </fieldset>
      )}
      {item.kind === 'skill' && (
        <label className="flex flex-col gap-1.5">
          <span className="label">{msg("固定版本（可选）")}</span>
          <input className="input mono" value={rev} onChange={(e) => setRev(e.target.value)} placeholder={msg("tag / 分支 / commit，例如 v1.2.0")} spellCheck={false} />
          <span className="text-[12px] leading-[1.6] text-ink3">
            {msg("等价于")}<code className="mono">--rev</code>{msg("：清单记录期望的版本，共享仓库 HEAD 不一致时 doctor 会警告（不自动切换）。需要隔离版本请添加后用「固定版本」。留空则跟随默认分支。")}</span>
        </label>
      )}
      {item.kind !== 'mcp' && targets.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="cap m-0">{msg("写入到")}</h2>
          {targets.map((p) => (
            <div key={p.id} className="agt tall mono !cursor-default text-[13px]">
              {p.name}
              <span className="ml-auto font-sans text-[12px] font-normal text-ink3">
                {item.kind === 'plugin' ? '.claude/settings.json' : '.agents/skills'}
              </span>
            </div>
          ))}
        </div>
      )}
      <EnvBlock item={item} />
      {single && (
        <div className="flex flex-col gap-2">
          <h2 className="cap m-0">{msg("上下文影响")}</h2>
          <div className="flex items-baseline gap-2.5">
            <span className="mono ca text-[26px] font-semibold">
              {fmtTok(before)} → {item.contextTokens === null ? '?' : fmtTok(before + item.contextTokens)}
            </span>
            {item.contextTokens === null && <span className="text-[12px] text-ink3">{displayName(item.kind, item.name)} {msg("尚未测量")}</span>}
          </div>
          {item.kind === 'mcp' && item.contextTokens === null && (
            <button
              type="button"
              className="btn btn-g btn-sm self-start"
              onClick={() =>
                api.measure(single.id, item.name).catch((e: unknown) => toast.push({ tone: 'err', title: msg("测量失败"), detail: (e as Error).message }))
              }
            >
              {msg("启动并测量")}</button>
          )}
        </div>
      )}
    </>
  );

  return (
    <WriteFlow
      open
      onClose={onClose}
      eyebrow={eyebrow}
      title={title}
      {...(!preset
        ? {
            select: {
              content: <ToolPicker items={candidates} value={picked} onChange={setPicked} {...(kind ? { kind } : {})} />,
              canContinue: !!item,
            },
          }
        : {})}
      aside={aside}
      writeOptions={item?.kind === 'skill' ? ['adopt', 'force'] : ['adopt']}
      previewKey={previewKey}
      preview={async (o) => {
        if (!spec) return { files: [], warnings: [], commands: [], errors: [] };
        const results: WriteResult[] = [];
        const errors: string[] = [];
        for (const p of targets) {
          try {
            results.push(await api.addTool(p.id, spec, { dryRun: true, adopt: o.adopt, force: o.force }));
          } catch (e) {
            const hint = e instanceof ApiError && e.code === 'CONFLICT' ? msg("（在下方「写入选项」勾选「接管同名的手写条目」后重试）") : '';
            errors.push(`${p.name}：${(e as Error).message}${hint}`);
          }
        }
        const pv = fromWriteResults(results, projects, errors);
        if (targets.length > 1) pv.commands = targets.map((p, i) => (results[i]?.command ? `(${p.name}) ${results[i]!.command}` : '')).filter(Boolean);
        return pv;
      }}
      commit={async (o) => {
        if (!spec) return;
        for (const p of targets) await api.addTool(p.id, spec, { adopt: o.adopt, force: o.force });
      }}
    />
  );
}

/** 「移到项目级」向导：pick projects → dryRun diff → confirm. */
export function MigrateFlow({ onClose, kind, name, suggested }: { onClose: () => void; kind: 'skill' | 'plugin'; name: string; suggested: string[] }) {
  useLocale();
  const api = useApi();
  const { data: projects = [] } = useProjects();
  const live = projects.filter((p) => p.exists);
  const [ids, setIds] = useState<string[]>(suggested.filter((id) => live.some((p) => p.id === id)));
  const [removeGlobal, setRemoveGlobal] = useState(true);
  const spec: MigrateSpec = { kind, name, projectIds: ids, removeGlobal };
  const pluginOnlyCC = kind === 'plugin';
  return (
    <WriteFlow
      open
      onClose={onClose}
      eyebrow={msg("全局 · 移到项目级")}
      title={
        <>
          <KindChip kind={kind} />
          <span className="mono ca">{displayName(kind, name)}</span>
        </>
      }
      select={{
        canContinue: ids.length > 0,
        content: (
          <div className="flex flex-wrap gap-6">
            <fieldset className="m-0 flex min-w-0 flex-[3_1_320px] flex-col gap-2 border-0 p-0">
              <legend className="cap pb-2.5">{msg("在这些项目中添加")}</legend>
              {projects.map((p) => {
                const disabled = !p.exists || (pluginOnlyCC && !p.agents.includes('claude-code'));
                const on = ids.includes(p.id);
                return (
                  <label key={p.id} className={`agt tall mono text-[13px] ${disabled ? 'disabled' : ''}`}>
                    <input type="checkbox" checked={on} disabled={disabled} onChange={() => setIds(on ? ids.filter((x) => x !== p.id) : [...ids, p.id])} />
                    {p.name}
                    <span className="ml-auto font-sans text-[12px] font-normal text-ink3">
                      {!p.exists ? msg("目录缺失") : disabled ? msg("未启用 Claude Code") : suggested.includes(p.id) ? msg("在用") : ''}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className="flex min-w-0 flex-[2_1_260px] flex-col gap-3">
              <h2 className="cap m-0">{msg("全局")}</h2>
              <div className="flex items-center gap-3.5 rounded-[14px] border border-line2 bg-glass-2 px-4 py-3.5">
                <Switch checked={removeGlobal} onChange={setRemoveGlobal} label={msg("迁移后从全局移除")} />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-medium">{msg("迁移后从全局移除")}</span>
                  <span className="mono text-[12px] text-ink3">{kind === 'plugin' ? '~/.claude/settings.json' : `~/.claude/skills/${name}`}</span>
                </span>
              </div>
              <p className="m-0 text-[12px] leading-[1.6] text-ink3">
                {removeGlobal
                  ? msg("其他项目的会话不再加载它，只有勾选的项目通过清单启用。")
                  : msg("保留全局启用：勾选的项目会在清单里声明它，但所有会话仍会加载。")}
              </p>
            </div>
          </div>
        ),
      }}
      previewKey={JSON.stringify(spec)}
      preview={async () => fromWriteResults([await api.migrate(spec, { dryRun: true })], projects)}
      commit={() => api.migrate(spec)}
      footnote={msg("先在每个项目执行 add（只改动 atm 管理的条目），全部成功后才修改全局配置；任一步失败都会回滚。")}
    />
  );
}
