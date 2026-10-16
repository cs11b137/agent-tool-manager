import { InstallToolDialog } from '../components/InstallToolDialog';
import { msg, useLocale } from '../lib/i18n';
import { CreateToolDialog, SharedRepositoryPanel } from '../components/SharedRepository';
import { useMemo, useState } from 'react';
import { useApi } from '../api/context';
import { useConfig, useLibrary, useProjects, useRepos } from '../api/queries';
import type { LibraryItem, ProjectSummary, ToolKind } from '../api/types';
import { Empty, ErrorBox, KindChip, Loading, PageHeader } from '../components/ui';
import { AddToolFlow } from '../components/flows';
import { CloneRepoDialog, NewMcpDialog, RegisterProjectDialog } from '../components/dialogs';
import { useToast } from '../components/Toaster';
import { displayName, fmtTokShort, shortHash, tildify } from '../lib/format';

type Filter = 'all' | ToolKind;
const FILTERS: Array<[Filter, string]> = [
  ['all', '全部'],
  ['skill', 'Skill'],
  ['mcp', 'MCP'],
  ['plugin', '插件'],
];

const key = (i: LibraryItem) => `${i.kind}:${i.name}`;
const GRID = '84px minmax(0, 2.2fr) minmax(0, 1.4fr) 96px 64px';

/** 共享仓库：`atm sync [repo...]` 的逐仓库入口。 */
function RepoList() {
  useLocale();
  const api = useApi();
  const toast = useToast();
  const repos = useRepos();
  const [busy, setBusy] = useState<string | null>(null);
  const sync = (repo: string) => {
    setBusy(repo);
    api
      .sync([repo])
      .catch((e: unknown) => toast.push({ tone: 'err', title: msg("sync {0} 失败", {0: repo}), detail: (e as Error).message }))
      .finally(() => setBusy(null));
  };
  if (!repos.data?.length) return null;
  return (
    <section aria-label={msg("共享仓库")} className="glass rise d3 overflow-hidden rounded-[20px]">
      <div className="flex items-center gap-2.5 border-b border-line px-[18px] py-4">
        <h2 className="m-0 text-[16px] font-semibold">{msg("共享仓库")}</h2>
        <span className="mono text-[13px] text-ink3">{repos.data.length}</span>
      </div>
      {repos.data.map((r) => (
        <div key={r.repo} className="hover-row flex flex-wrap items-center gap-3 border-b border-line px-[18px] py-3 last:border-0">
          <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
            <span className="mono truncate text-[14px] font-medium">{r.repo}</span>
            <span className="mono truncate text-[12px] text-ink3">{tildify(r.dir)}</span>
          </div>
          <span className="mono text-[12px] text-ink2">
            {r.branch ?? 'HEAD'} · {shortHash(r.head)}
          </span>
          {r.dirty && (
            <span className="chip" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
              {msg("有未提交改动")}</span>
          )}
          {r.ahead > 0 && (
            <span className="chip" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
              {msg("领先远端 {0} 个提交", {0: r.ahead})}
            </span>
          )}
          <span className="text-[12px] text-ink3">{r.usedBy.length} {msg("个项目在用")}</span>
          <button type="button" className="btn btn-g btn-sm" disabled={busy === r.repo} aria-label={`sync ${r.repo}`} onClick={() => sync(r.repo)}>
            {msg('同步仓库')}
          </button>
        </div>
      ))}
    </section>
  );
}

export function sourceLabel(i: LibraryItem): string {
  if (i.kind === 'mcp' && i.mcp) return `${i.mcp.origin} · ${i.mcp.transport}`;
  if (i.kind === 'plugin') return i.plugin?.localSource ? msg("共享仓库 · 本地插件") : 'installed_plugins.json';
  if (i.skill?.repo === 'atm:shared') return msg("共享仓库");
  return i.source;
}

function subLine(i: LibraryItem): string {
  return i.description ?? i.detail ?? '';
}

function tokLabel(i: LibraryItem): string {
  if (i.contextTokens === null && i.kind === 'skill') return '—';
  return fmtTokShort(i.contextTokens);
}

function eligible(i: LibraryItem, p: ProjectSummary): { ok: boolean; hint: string; has: boolean } {
  const has = i.usedBy.includes(p.id);
  if (!p.exists) return { ok: false, hint: msg("目录缺失"), has };
  if (has) return { ok: false, hint: msg("已在用"), has };
  if (!p.initialized) return { ok: false, hint: msg("未初始化"), has };
  if (i.kind === 'plugin' && !p.agents.includes('claude-code')) return { ok: false, hint: msg("未启用 Claude Code"), has };
  return { ok: true, hint: '', has };
}

function AddPanel({ item, projects }: { item: LibraryItem; projects: ProjectSummary[] }) {
  useLocale();
  const firstEligible = projects.find((p) => eligible(item, p).ok);
  const [picked, setPicked] = useState<string[]>(firstEligible ? [firstEligible.id] : []);
  const [open, setOpen] = useState(false);
  const targets = picked.filter((id) => projects.some((p) => p.id === id && eligible(item, p).ok));
  return (
    <aside aria-label={msg("添加到项目")} className="glass iri rise d3 box-border flex flex-[1_1_300px] flex-col gap-[18px] rounded-[20px] p-[22px]" style={{ background: 'var(--glass-strong)' }}>
      <div key={key(item)} className="swap flex flex-col gap-2">
        <KindChip kind={item.kind} className="self-start" />
        <h2 className="mono ca m-0 text-[22px] font-semibold break-all">{displayName(item.kind, item.name)}</h2>
        {subLine(item) && <span className="text-[14px] leading-[1.6] text-ink2">{subLine(item)}</span>}
        <code className="mono text-[12px] break-all text-ink3">{sourceLabel(item)}</code>
        {item.mcp?.envVars.some((v) => !v.set) && (
          <span className="text-[12px] text-warn-ink">
            {msg("未设置：")}{item.mcp.envVars.filter((v) => !v.set).map((v) => v.name).join('、')}
          </span>
        )}
      </div>
      {projects.length === 0 && <p className="text-sm text-ink2">{msg("先点击“添加项目目录…”，再选择要关联的项目。")}</p>}
      {item.plugin?.localSource && <p className="text-xs leading-6 text-ink3">{msg("关联后，请在 Claude Code 首次打开项目时确认安装共享 marketplace 插件。")}</p>}
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="cap pb-2.5">{msg("添加到项目")}</legend>
        {projects.map((p) => {
          const e = eligible(item, p);
          const checked = e.has || (e.ok && picked.includes(p.id));
          return (
            <label key={p.id} className="agt tall mono text-[13px] font-normal" style={{ color: p.exists ? 'var(--ink)' : 'var(--ink3)', cursor: e.ok ? 'pointer' : 'default' }}>
              <input type="checkbox" checked={checked} disabled={!e.ok} onChange={() => setPicked(checked ? picked.filter((x) => x !== p.id) : [...picked, p.id])} />
              {p.name}
              <span className="ml-auto font-sans text-[12px] text-ink3">{e.hint}</span>
            </label>
          );
        })}
      </fieldset>
      <button type="button" className="btn btn-p btn-lg" disabled={!targets.length} onClick={() => setOpen(true)}>
        {msg("预览 diff")}</button>
      <p className="m-0 text-[12px] leading-[1.6] text-ink3">{msg("会对每个勾选的项目分别执行 dryRun，确认后一次写入。")}</p>
      {open && <AddToolFlow onClose={() => setOpen(false)} projectIds={targets} item={item} />}
    </aside>
  );
}

export function LibraryPage() {
  useLocale();
  const config = useConfig();
  const library = useLibrary();
  const projects = useProjects();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'clone' | 'mcp' | 'tool' | 'project' | 'url' | 'upload' | 'search' | 'github' | null>(null);

  const all = library.data ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: all.length, skill: 0, mcp: 0, plugin: 0 };
    for (const i of all) c[i.kind]++;
    return c;
  }, [all]);
  const needle = q.trim().toLowerCase();
  const rows = all.filter(
    (i) => (filter === 'all' || i.kind === filter) && (!needle || [i.name, i.source, i.description ?? '', i.detail ?? ''].some((s) => s.toLowerCase().includes(needle))),
  );
  const selected = all.find((i) => key(i) === sel) ?? all.find((i) => !i.global && i.usedBy.length === 0) ?? all[0];

  return (
    <>
      <PageHeader
        cap={<span className="break-all">{msg("{0} · {1} · 已添加的插件", {0: config.data ? tildify(config.data.root) : '~/.agent-tools', 1: config.data ? tildify(config.data.mcpRegistry) : 'MCP registry'})}</span>}
        title={msg("工具库")}
        actions={
          <>
            <button type="button" className="btn btn-p" onClick={() => setDialog('tool')}>{msg("新建工具…")}</button>
            <button type="button" className="btn btn-g" onClick={() => setDialog('search')}>{msg("搜索安装…")}</button>
            <button type="button" className="btn btn-g" onClick={() => setDialog('url')}>{msg("下载安装…")}</button>
            <button type="button" className="btn btn-g" onClick={() => setDialog('upload')}>{msg("上传工具包…")}</button>
            <button type="button" className="btn btn-g" onClick={() => setDialog('project')}>{msg("添加项目目录…")}</button>
            <button type="button" className="btn btn-g" onClick={() => setDialog('clone')}>
              {msg("克隆仓库…")}</button>
            <button type="button" className="btn btn-g" onClick={() => setDialog('mcp')}>
              {msg("新建 MCP 定义…")}</button>
          </>
        }
      />

      <div className="rise d1 flex flex-wrap items-end gap-3">
        <div className="flex flex-[1_1_280px] flex-col gap-1.5">
          <label htmlFor="lib-search" className="label">
            {msg("搜索工具")}</label>
          <input id="lib-search" type="search" className="input input-lg" placeholder={msg("按名称、仓库或描述搜索")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div role="tablist" aria-label={msg("类型")} className="glass flex gap-1 rounded-full p-1">
          {FILTERS.map(([f, label]) => (
            <button key={f} type="button" role="tab" className="seg" aria-selected={filter === f} onClick={() => setFilter(f)}>
              {msg(label)} <span className="mono text-[12px] opacity-70">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      {library.error != null && <ErrorBox error={library.error} />}

      <div className="flex flex-wrap items-start gap-4">
        <section aria-label={msg("工具列表")} className="glass rise d2 min-w-0 flex-[999_1_520px] overflow-hidden rounded-[20px]">
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              <div className="cap grid gap-3 border-b border-line px-[18px] py-3.5" style={{ gridTemplateColumns: GRID }}>
                <span>{msg("类型")}</span>
                <span>{msg("名称")}</span>
                <span>{msg("来源")}</span>
                <span>{msg("使用")}</span>
                <span className="text-right">tokens</span>
              </div>
              {library.isLoading && <Loading />}
              {!library.isLoading && !library.error && rows.length === 0 && <Empty>
                {all.length === 0 && !needle ? <>
                  <strong className="block text-ink">{msg("还没有添加工具")}</strong>
                  <span className="mt-2 block">{msg("共享仓库已准备好。下载、上传或新建工具，再关联到项目。")}</span>
                  <button type="button" className="btn btn-p mt-4" onClick={() => setDialog('tool')}>{msg("新建第一个工具")}</button>
                </> : msg("没有匹配的工具。")}
              </Empty>}
              {rows.map((i) => {
                const on = selected ? key(i) === key(selected) : false;
                const used = i.global ? msg("全局") : i.usedBy.length ? msg("{0} 个项目", {0: i.usedBy.length}) : msg("未使用");
                return (
                  <button
                    key={key(i)}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSel(key(i))}
                    className="hover-row grid min-h-[60px] w-full cursor-pointer items-center gap-3 border-0 border-b border-solid border-line px-[18px] py-2 text-left font-sans text-ink"
                    style={{ gridTemplateColumns: GRID, background: on ? 'var(--accent-soft)' : 'transparent' }}
                  >
                    <KindChip kind={i.kind} className="justify-self-start" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="mono truncate text-[14px] font-medium">{displayName(i.kind, i.name)}</span>
                      <span className="truncate text-[12px] text-ink3">{subLine(i)}</span>
                    </span>
                    <span className="mono truncate text-[12px] text-ink2">{sourceLabel(i)}</span>
                    <span className="text-[13px]" style={{ color: i.global || i.usedBy.length ? 'var(--ink)' : 'var(--ink3)' }}>
                      {used}
                    </span>
                    <span className="mono text-right text-[13px] font-semibold">{tokLabel(i)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
        {selected && projects.data && <AddPanel key={key(selected)} item={selected} projects={projects.data} />}
      </div>

      <SharedRepositoryPanel />
      <RepoList />

      {(dialog === 'url' || dialog === 'upload' || dialog === 'search' || dialog === 'github') && <InstallToolDialog mode={dialog} onClose={() => setDialog(null)} />}
      {dialog === 'tool' && <CreateToolDialog onClose={() => setDialog(null)} />}
      {dialog === 'project' && <RegisterProjectDialog onClose={() => setDialog(null)} />}
      {dialog === 'clone' && <CloneRepoDialog onClose={() => setDialog(null)} />}
      {dialog === 'mcp' && <NewMcpDialog onClose={() => setDialog(null)} />}
    </>
  );
}
