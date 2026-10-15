import { msg, useLocale } from '../lib/i18n';
import { useState } from 'react';
import { Link } from 'react-router';
import { useGlobal, useProjects } from '../api/queries';
import type { GlobalReport, ProjectSummary } from '../api/types';
import { ContextBar, Empty, ErrorBox, KindChip, LevelGlyph, Loading, PageHeader } from '../components/ui';
import { MigrateFlow } from '../components/flows';
import { displayName, fmtTok, tildify } from '../lib/format';

type Target = { kind: 'skill' | 'plugin'; name: string; suggested: string[] };

function ProjectChips({ ids, projects, tone = 'agent' }: { ids: string[]; projects: ProjectSummary[]; tone?: 'agent' | 'warn' }) {
  useLocale();
  return (
    <>
      {ids.map((id) => {
        const p = projects.find((x) => x.id === id);
        const style = tone === 'warn' ? { background: 'var(--warn-soft)', color: 'var(--warn-ink)' } : undefined;
        return (
          <Link key={id} to={`/projects/${id}`} className={`chip no-underline ${tone === 'agent' ? 'c-agent mono' : ''}`} style={style}>
            {p?.name ?? id}
          </Link>
        );
      })}
    </>
  );
}

function suggestions(g: GlobalReport) {
  return [...g.skills.filter((s) => s.shadowedBy.length > 0).map((s) => s.name), ...g.plugins.filter((p) => p.usedBy.length <= 1).map((p) => displayName('plugin', p.name))];
}

export function GlobalPage() {
  useLocale();
  const [scanning, setScanning] = useState(false);
  const global = useGlobal(scanning);
  const projects = useProjects();
  const [target, setTarget] = useState<Target | null>(null);

  if (!scanning) return <>
    <PageHeader title={msg("全局")} cap={msg("本机 Agent 工具")} />
    <Empty className="glass rounded-[20px]">
      <strong className="block text-ink">{msg("尚未扫描本机全局工具")}</strong>
      <span className="mt-2 block">{msg("扫描后可查看已有全局工具，并选择迁移到项目中管理。")}</span>
      <button type="button" className="btn btn-p mt-4" onClick={() => setScanning(true)}>{msg("扫描本机全局工具")}</button>
    </Empty>
  </>;

  if (global.isLoading) return <Loading />;
  if (global.error || !global.data) return <ErrorBox error={global.error ?? new Error(msg("无法读取全局配置"))} />;

  const g = global.data;
  const list = projects.data ?? [];
  const skillTok = g.skills.reduce((s, x) => s + x.contextTokens, 0);
  const pluginTok = g.plugins.reduce((s, x) => s + (x.contextTokens ?? 0), 0);
  const unmeasured = g.plugins.filter((x) => x.contextTokens === null).length;
  const sugg = suggestions(g);

  return (
    <>
      <PageHeader
        cap="~/.claude/skills · ~/.claude/settings.json"
        title={msg("全局")}
        sub={<span className="text-[14px] text-ink2">{msg("全局工具会被每个会话加载。只有少数项目在用的，建议移到项目级清单，按需启用。")}</span>}
      />

      <section className="glass iri rise d1 flex flex-wrap items-center gap-8 rounded-[20px] px-6 py-[22px]" style={{ background: 'var(--glass-strong)' }}>
        <div className="flex flex-[7_1_360px] flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="cap">{msg("每个会话都会加载")}</span>
            <span className="mono ca text-[32px] font-semibold">
              ≈ {fmtTok(skillTok + pluginTok)}
              {unmeasured > 0 && ' + ?'}{' '}
              <span className="text-[13px] font-normal text-ink3" style={{ textShadow: 'none' }}>
                {msg("tokens / 会话")}</span>
            </span>
          </div>
          <ContextBar context={{ skill: skillTok, mcp: 0, plugin: pluginTok, total: skillTok + pluginTok, unmeasured }} height={12} />
          <div className="flex flex-wrap gap-4 text-[12px] text-ink2">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: 'var(--skill)' }} />
              {msg("全局 Skill")} {fmtTok(skillTok)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: 'var(--plugin)' }} />
              {msg("全局插件")} {fmtTok(pluginTok)}
            </span>
            {unmeasured > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="hatch h-2 w-2 rounded-full border border-line2" />
                {msg("{0} 项未测量", {0: unmeasured})}</span>
            )}
          </div>
        </div>
        <div className="flex flex-[5_1_280px] flex-col gap-2">
          <span className="cap">{msg("迁移建议")}</span>
          {sugg.length ? (
            <>
              <span className="text-[24px] font-semibold">
                <span className="mono">{sugg.length}</span> <span className="text-[14px] font-normal text-ink2">{msg("项可以移到项目级")}</span>
              </span>
              <span className="mono text-[12px] text-ink3">{sugg.join(' · ')}</span>
            </>
          ) : (
            <span className="inline-flex items-center gap-2 text-[14px] text-ink2">
              <LevelGlyph level="ok" size={8} />
              {msg("全局配置已经很精简")}</span>
          )}
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section className="glass rise d2 min-w-0 flex-[1_1_420px] overflow-hidden rounded-[20px]">
          <div className="flex items-center gap-2.5 border-b border-line px-[18px] py-4">
            <KindChip kind="skill" />
            <h2 className="m-0 text-[16px] font-semibold">{msg("全局 Skill")}</h2>
            <span className="mono text-[13px] text-ink3">{g.skills.length}</span>
          </div>
          {g.skills.length === 0 && <Empty className="border-b border-line">{msg("~/.claude/skills 是空的。")}</Empty>}
          {g.skills.map((s) => (
            <div key={s.name} className="hover-row flex flex-wrap items-center gap-4 border-b border-line px-[18px] py-4">
              <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
                <div className="flex justify-between gap-2">
                  <span className="mono text-[14px] font-medium">{s.name}</span>
                  <span className="mono text-[13px] font-semibold">{fmtTok(s.contextTokens)}</span>
                </div>
                <span className="mono text-[12px] break-all text-ink3">
                  {tildify(s.path)}
                  {s.target ? ` → ${tildify(s.target)}` : ''}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {s.shadowedBy.length > 0 ? (
                    <>
                      <span className="text-[12px] text-warn-ink">{msg("与项目 Skill 同名：")}</span>
                      <ProjectChips ids={s.shadowedBy} projects={list} tone="warn" />
                    </>
                  ) : (
                    <span className="text-[12px] text-ink2">{msg("没有项目重复引用")}</span>
                  )}
                </div>
              </div>
              <button type="button" className="btn btn-g" onClick={() => setTarget({ kind: 'skill', name: s.name, suggested: s.shadowedBy })}>
                {msg("移到项目级…")}</button>
            </div>
          ))}
          <p className="m-0 px-[18px] py-3 text-[12px] leading-[1.5] text-ink3">{msg("全局 Skill 对所有项目的 Claude Code 会话生效；与项目内同名时会加载两份。")}</p>
        </section>

        <section className="glass rise d3 min-w-0 flex-[1_1_420px] overflow-hidden rounded-[20px]">
          <div className="flex items-center gap-2.5 border-b border-line px-[18px] py-4">
            <KindChip kind="plugin" />
            <h2 className="m-0 text-[16px] font-semibold">{msg("全局启用的插件")}</h2>
            <span className="mono text-[13px] text-ink3">{g.plugins.length}</span>
          </div>
          {g.plugins.length === 0 && <Empty className="border-b border-line">{msg("没有全局启用的插件。")}</Empty>}
          {g.plugins.map((p) => {
            const at = p.name.indexOf('@');
            const suggest = p.usedBy.length <= 1;
            return (
              <div key={p.name} className="hover-row flex flex-wrap items-center gap-4 border-b border-line px-[18px] py-4">
                <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
                  <div className="flex justify-between gap-2">
                    <span className="mono text-[14px] font-medium">{displayName('plugin', p.name)}</span>
                    <span className="mono text-[13px] font-semibold">{p.contextTokens === null ? '?' : fmtTok(p.contextTokens)}</span>
                  </div>
                  <span className="mono text-[12px] text-ink3">{at > 0 ? p.name.slice(at) : p.name}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="chip font-medium" style={p.installed ? { background: 'var(--line)', color: 'var(--ink2)' } : { background: 'var(--err-soft)', color: 'var(--err-ink)' }}>
                      {p.installed ? msg("已安装") : msg("未安装")}
                    </span>
                    {p.usedBy.length > 0 ? (
                      <>
                        <span className="text-[12px] text-ink2">{msg("在用：")}</span>
                        <ProjectChips ids={p.usedBy} projects={list} />
                      </>
                    ) : (
                      <span className="text-[12px] text-ink3">{msg("没有项目在用")}</span>
                    )}
                  </div>
                  {suggest && (
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink2">
                      <LevelGlyph level="info" size={7} />
                      {p.usedBy.length === 1 ? msg("只有 1 个项目在用，改为项目级后其他会话不再加载它") : msg("没有项目在用，可以直接从全局移除")}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className={`btn ${suggest ? 'btn-p' : 'btn-g'}`}
                  onClick={() => setTarget({ kind: 'plugin', name: p.name, suggested: p.usedBy })}
                >
                  {msg("移到项目级…")}</button>
              </div>
            );
          })}
          <p className="m-0 px-[18px] py-3 text-[12px] leading-[1.5] text-ink3">{msg("读取 ~/.claude/settings.json 的 enabledPlugins；项目级启用写入各项目的 .claude/settings.json。")}</p>
        </section>
      </div>

      <p className="rise d4 m-0 text-[12px] leading-[1.6] text-ink3">{msg("「移到项目级」向导：选择用到它的项目 → 预览每个文件的 diff → 确认后在这些项目中添加，再从全局移除。")}</p>

      {target && <MigrateFlow onClose={() => setTarget(null)} kind={target.kind} name={target.name} suggested={target.suggested} />}
    </>
  );
}
