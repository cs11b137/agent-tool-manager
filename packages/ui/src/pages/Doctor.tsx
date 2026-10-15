import { msg, useLocale } from '../lib/i18n';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Check } from 'lucide-react';
import { useApi } from '../api/context';
import { useDoctor, useProjects, useRepos } from '../api/queries';
import type { DoctorIssue, DoctorLevel } from '../api/types';
import { Empty, ErrorBox, KindChip, LevelGlyph, Loading, PageHeader, Rich } from '../components/ui';
import { MigrateFlow, OpFlow, type OpFlowConfig } from '../components/flows';
import { SimpleDialog } from '../components/Dialog';
import { useToast } from '../components/Toaster';
import { useAcknowledged } from '../lib/ack';
import { hhmm, tildify } from '../lib/format';

function RepoDialog({ repo, onClose }: { repo: string; onClose: () => void }) {
  useLocale();
  const repos = useRepos();
  const projects = useProjects();
  const r = repos.data?.find((x) => x.repo === repo);
  const users = (projects.data ?? []).filter((p) => r?.usedBy.includes(p.id)).map((p) => p.name);
  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap={msg("共享仓库")}
      title={<span className="mono">{repo}</span>}
      footer={
        <button type="button" className="btn btn-p btn-lg" onClick={onClose}>
          {msg("知道了")}</button>
      }
    >
      {!r ? (
        <Loading className="!px-0" />
      ) : (
        <>
          <dl className="m-0 grid grid-cols-[84px_1fr] gap-y-2.5 text-[13px]">
            <dt className="text-ink3">{msg("目录")}</dt>
            <dd className="mono m-0 break-all">{tildify(r.dir)}</dd>
            <dt className="text-ink3">{msg("分支")}</dt>
            <dd className="mono m-0">
              {r.branch ?? '(detached)'} · {r.head.slice(0, 7)}
            </dd>
            <dt className="text-ink3">{msg("状态")}</dt>
            <dd className="m-0">
              {r.dirty ? msg("有未提交的改动") : msg("工作区干净")}
              {r.ahead > 0 ? msg(" · 领先远端 {0} 个提交", {0: r.ahead}) : ''}
            </dd>
            <dt className="text-ink3">{msg("被引用")}</dt>
            <dd className="mono m-0">{users.length ? users.join('、') : '—'}</dd>
          </dl>
          <div className="flex flex-col gap-1.5">
            <span className="cap">{msg("在终端查看")}</span>
            <code className="mono rounded-[12px] border border-line2 bg-glass-2 px-3.5 py-2.5 text-[12px] leading-[1.8] break-all">
              git -C {tildify(r.dir)} status
              <br />
              git -C {tildify(r.dir)} diff
            </code>
          </div>
          <p className="m-0 text-[12px] leading-[1.6] text-ink3">{msg("atm 不会替你提交或丢弃改动。改动已经对所有引用它的项目生效；确认无误可以给上游提 PR。")}</p>
        </>
      )}
    </SimpleDialog>
  );
}

const LEVEL_INK: Record<DoctorLevel, string> = { error: 'var(--err-ink)', warn: 'var(--warn-ink)', info: 'var(--ink3)' };

function Section({ level, children, delay }: { level: DoctorLevel; children: ReactNode; delay: number }) {
  useLocale();
  return (
    <section aria-labelledby={`h-${level}`} className={`glass rise d${delay} overflow-hidden rounded-[20px]`}>
      <h2 id={`h-${level}`} className="cap m-0 flex items-center gap-2 border-b border-line px-5 py-3.5" style={{ color: LEVEL_INK[level] }}>
        <LevelGlyph level={level} size={level === 'info' ? 8 : 8} />
        {level}
      </h2>
      {children}
    </section>
  );
}

function ProjectRef({ issue, link }: { issue: DoctorIssue; link: boolean }) {
  useLocale();
  if (!issue.projectName) return null;
  return link && issue.projectId ? (
    <Link to={`/projects/${issue.projectId}`} className="mono text-[13px] font-medium text-accent-ink">
      {issue.projectName}
    </Link>
  ) : (
    <span className="mono text-[13px] font-medium">{issue.projectName}</span>
  );
}

export function DoctorPage() {
  useLocale();
  const api = useApi();
  const toast = useToast();
  const doctor = useDoctor();
  const { ids: acked, ack } = useAcknowledged();
  const [flow, setFlow] = useState<OpFlowConfig | null>(null);
  const [fixedNote, setFixedNote] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [migrate, setMigrate] = useState<DoctorIssue | null>(null);

  if (doctor.isLoading) return <Loading />;
  if (doctor.error || !doctor.data) return <ErrorBox error={doctor.error ?? new Error(msg("无法读取体检结果"))} />;

  const report = doctor.data;
  const issues = report.issues.filter((i) => !acked.includes(i.id));
  const by = (l: DoctorLevel) => issues.filter((i) => i.level === l);
  const errors = by('error');
  const warns = by('warn');
  const infos = by('info');
  const fixable = issues.filter((i) => i.fixable);

  const fix = (list: DoctorIssue[]) => {
    const ids = list.map((i) => i.id);
    const note = list.map((i) => `\`.agents/skills/${i.name ?? ''}\``).join('、');
    setFlow({
      eyebrow: msg("体检 · 一键修复"),
      title: <span>{list.length === 1 ? msg("重建软链 {0}", {0: list[0]!.name ?? ''}) : msg("修复 {0} 项", {0: list.length})}</span>,
      run: (dryRun) => api.fix(ids, { dryRun }),
      onCommitted: () => setFixedNote(note),
      footnote: msg("只处理能安全修复的项：按清单重建软链，不改动清单与 Agent 配置。"),
    });
  };

  const measure = () => {
    api.getDoctor(undefined, { measure: true }).catch((e: unknown) => toast.push({ tone: 'err', title: msg("检查失败"), detail: (e as Error).message }));
  };

  const errText = errors.length ? (errors.every((i) => i.fixable) ? msg("error · 可安全修复") : msg("error · 需要处理")) : fixedNote ? msg("error · 全部已修复") : msg("error · 无");

  const warnActions = (i: DoctorIssue): ReactNode => {
    if (i.code === 'mcp-dup-plugin' && i.projectId && i.name) {
      const pid = i.projectId;
      const name = i.name;
      return (
        <>
          <button
            type="button"
            className="btn btn-g"
            onClick={() => {
              ack(i.id);
              toast.push({ tone: 'ok', title: msg("保留清单里的 {0}", {0: name}), detail: msg("这条告警已在本机隐藏") });
            }}
          >
            {msg("保留清单的 MCP")}</button>
          <button
            type="button"
            className="btn btn-g"
            onClick={() =>
              setFlow({
                eyebrow: msg("{0} · 改用插件版本", {0: i.projectName ?? ''}),
                title: (
                  <>
                    <KindChip kind="mcp" />
                    <span className="mono ca">{msg("移除 {0}", {0: name})}</span>
                  </>
                ),
                run: (dryRun) => api.removeTool(pid, 'mcp', name, { dryRun }),
              })
            }
          >
            {msg("改用插件版本")}</button>
        </>
      );
    }
    if (i.code === 'skill-shadowed') {
      return (
        <Link to="/global" className="btn btn-g">
          {msg("打开全局页")}</Link>
      );
    }
    if (i.code === 'rev-mismatch' && i.projectId) {
      const pid = i.projectId;
      return (
        <button type="button" className="btn btn-g" onClick={() => setFlow({ eyebrow: `${i.projectName ?? ''} · install`, title: <span className="mono ca">atm install</span>, run: (dryRun, o) => api.install(pid, { dryRun, adopt: o.adopt, force: o.force, strict: o.strict }), writeOptions: ['strict', 'adopt', 'force'] })}>
          install
        </button>
      );
    }
    return null;
  };

  const infoAction = (i: DoctorIssue): ReactNode => {
    switch (i.code) {
      case 'repo-dirty':
        return (
          <button type="button" className="btn btn-g" onClick={() => setRepo(i.name ?? '')}>
            {msg("查看改动")}</button>
        );
      case 'plugin-global-only':
        return (
          <button type="button" className="btn btn-g" onClick={() => setMigrate(i)}>
            {msg("移到项目级…")}</button>
        );
      case 'context-total':
        return i.projectId ? (
          <Link to={`/projects/${i.projectId}`} className="btn btn-g">
            {msg("打开项目")}</Link>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <>
      <PageHeader
        cap={msg("{0} 个项目 · atm doctor · {1} 更新", {0: report.projects.length, 1: hhmm(report.checkedAt)})}
        title={msg("体检")}
        actions={
          <>
            <button type="button" className="btn btn-g" onClick={measure}>
              {msg("重新检查（含 --measure）")}</button>
            <button type="button" className="btn btn-p" disabled={!fixable.length} onClick={() => fix(fixable)}>
              {fixable.length ? msg("一键修复安全项（{0}）", {0: fixable.length}) : msg("没有可自动修复的项")}
            </button>
          </>
        }
      />

      <div className="rise d1 grid gap-3 md:grid-cols-[5fr_4fr_3fr]">
        <div className={`glass flex items-center gap-4 rounded-[20px] px-[22px] py-5 ${errors.length ? 'iri' : ''}`} style={{ background: 'var(--glass-strong)' }}>
          <span className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: errors.length ? 'var(--err-soft)' : 'var(--ok-soft)', transition: 'background-color .5s' }}>
            <span className="h-3.5 w-3.5 rounded-full" style={{ background: errors.length ? 'var(--err)' : 'var(--ok)', transition: 'background-color .5s' }} />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="mono ca text-[34px] leading-none font-semibold">{errors.length}</span>
            <span className="text-[13px] text-ink2">{errText}</span>
          </span>
        </div>
        <div className="glass flex items-center gap-4 rounded-[20px] px-[22px] py-5">
          <span className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: 'var(--warn-soft)' }}>
            <LevelGlyph level="warn" size={14} />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="mono text-[34px] leading-none font-semibold">{warns.length}</span>
            <span className="text-[13px] text-ink2">{msg("warn · 需要你决定")}</span>
          </span>
        </div>
        <div className="glass flex items-center gap-4 rounded-[20px] px-[22px] py-5">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-line">
            <LevelGlyph level="info" size={12} />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="mono text-[34px] leading-none font-semibold">{infos.length}</span>
            <span className="text-[13px] text-ink2">info</span>
          </span>
        </div>
      </div>

      <Section level="error" delay={2}>
        {errors.length === 0 && (
          <div className="morph flex flex-wrap items-center gap-3 px-5 py-[18px] text-[14px]" style={{ background: 'var(--ok-soft)' }}>
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-white" style={{ background: 'var(--ok)' }}>
              <Check size={13} strokeWidth={3} aria-hidden />
            </span>
            <span>{fixedNote ? <Rich text={msg("已重建软链 {0}，没有其他 error", {0: fixedNote})} /> : msg("没有 error")}</span>
          </div>
        )}
        {errors.map((i, idx) => (
          <div key={i.id} className={`hover-row flex flex-wrap items-center gap-4 px-5 py-[18px] ${idx < errors.length - 1 ? 'border-b border-line' : ''}`}>
            <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProjectRef issue={i} link={false} />
                {i.kind && <KindChip kind={i.kind} />}
                <strong className="text-[15px]">{i.title}</strong>
              </div>
              {i.detail && (
                <code className="mono text-[12px] break-all text-ink2">
                  <Rich text={i.detail} />
                </code>
              )}
              {i.nextCommand && <span className="mono text-[12px] text-ink3">{msg("下一步：")}{i.nextCommand}</span>}
            </div>
            {i.fixable && (
              <button type="button" className="btn btn-p" onClick={() => fix([i])}>
                {i.code === 'broken-link' || i.code === 'missing-link' ? msg("重建软链") : msg("修复")}
              </button>
            )}
            {i.code === 'project-missing' && i.projectId && (
              <Link to={`/projects/${i.projectId}`} className="btn btn-g">
                {msg("重新定位…")}</Link>
            )}
          </div>
        ))}
      </Section>

      {warns.length > 0 && (
        <Section level="warn" delay={3}>
          {warns.map((i, idx) => (
            <div key={i.id} className={`hover-row flex flex-wrap items-center gap-4 px-5 py-[18px] ${idx < warns.length - 1 ? 'border-b border-line' : ''}`}>
              <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <ProjectRef issue={i} link />
                  {i.kind && <KindChip kind={i.kind} />}
                  <strong className="text-[15px]">{i.title}</strong>
                </div>
                {i.detail && (
                  <span className="text-[14px] leading-[1.6] text-ink2">
                    <Rich text={i.detail} />
                  </span>
                )}
                <span className="text-[12px] text-ink3">
                  {i.code === 'mcp-dup-plugin' ? msg("需要你决定保留哪一个，atm 不会自动处理") : i.code === 'skill-shadowed' ? msg("需要你决定保留哪一份，atm 不会自动处理") : msg("下一步：{0}", {0: i.nextCommand ?? 'atm doctor'})}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">{warnActions(i)}</div>
            </div>
          ))}
        </Section>
      )}

      {infos.length > 0 && (
        <Section level="info" delay={4}>
          {infos.map((i, idx) => (
            <div key={i.id} className={`hover-row flex flex-wrap items-center gap-4 px-5 py-4 ${idx < infos.length - 1 ? 'border-b border-line' : ''}`}>
              <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
                <span className="text-[14px]">
                  <Rich text={i.title} />
                </span>
                {i.detail && (
                  <span className="text-[12px] text-ink3">
                    <Rich text={i.detail} />
                  </span>
                )}
              </div>
              {infoAction(i)}
            </div>
          ))}
        </Section>
      )}

      {issues.length === 0 && <Empty className="glass rounded-[20px]">{msg("所有项目都很健康。")}</Empty>}

      <OpFlow config={flow} onClose={() => setFlow(null)} />
      {repo && <RepoDialog repo={repo} onClose={() => setRepo(null)} />}
      {migrate?.name && (
        <MigrateFlow onClose={() => setMigrate(null)} kind="plugin" name={migrate.name} suggested={migrate.projectId ? [migrate.projectId] : []} />
      )}
    </>
  );
}

