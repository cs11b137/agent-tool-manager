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
import { doctorCopy } from '../lib/doctor-copy';

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
              {r.branch ?? msg('未关联分支')} · {r.head.slice(0, 7)}
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
            <code className="mono rounded-[8px] border border-line2 bg-field px-3.5 py-2.5 text-[12px] leading-[1.8] break-all">
              git -C {tildify(r.dir)} status
              <br />
              git -C {tildify(r.dir)} diff
            </code>
          </div>
          <p className="m-0 text-[12px] leading-[1.6] text-ink3">{msg("不会自动提交或丢弃改动。共享仓库的改动会影响引用它的项目，请确认后再提交。")}</p>
        </>
      )}
    </SimpleDialog>
  );
}

const LEVEL_INK: Record<DoctorLevel, string> = { error: 'var(--err-ink)', warn: 'var(--warn-ink)', info: 'var(--ink3)' };

function Section({ level, children }: { level: DoctorLevel; children: ReactNode }) {
  useLocale();
  return (
    <section aria-labelledby={`h-${level}`} className="glass overflow-hidden rounded-[8px]">
      <h2 id={`h-${level}`} className="cap m-0 flex items-center gap-2 border-b border-line px-3.5 py-2.5" style={{ color: LEVEL_INK[level] }}>
        <LevelGlyph level={level} size={8} />
        {msg({ error: '错误', warn: '警告', info: '提示' }[level])}
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

function DiagnosticDetails({ issue }: { issue: DoctorIssue }) {
  return <details className="text-[12px] text-ink3">
    <summary className="cursor-pointer">{msg('原始诊断与处理建议')}</summary>
    <div className="mt-2 flex flex-col gap-1.5 break-words">
      <Rich text={issue.title} />
      {issue.detail && <Rich text={issue.detail} />}
      {issue.nextCommand && <code className="mono break-all">{issue.nextCommand}</code>}
    </div>
  </details>;
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
  if (doctor.error || !doctor.data) return <ErrorBox error={doctor.error ?? new Error(msg("无法读取检查结果"))} />;

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
      footnote: msg("仅按工具清单重建缺失或失效的链接，不修改清单和应用配置。"),
    });
  };

  const measure = () => {
    api.getDoctor(undefined, { measure: true }).catch((e: unknown) => toast.push({ tone: 'err', title: msg("检查失败"), detail: (e as Error).message }));
  };

  const errText = errors.length ? (errors.every((i) => i.fixable) ? msg("错误 · 可自动修复") : msg("错误 · 需要处理")) : fixedNote ? msg("错误 · 已修复") : msg("错误 · 未发现");

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
              toast.push({ tone: 'ok', title: msg("保留清单里的 {0}", {0: name}), detail: msg("这条警告已在本机隐藏") });
            }}
          >
            {msg("保留清单版本")}</button>
          <button
            type="button"
            className="btn btn-g"
            onClick={() =>
              setFlow({
                eyebrow: msg("{0} · 改用插件版本", {0: i.projectName ?? ''}),
                title: (
                  <>
                    <KindChip kind="mcp" />
                    <span className="mono">{msg("移除 {0}", {0: name})}</span>
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
        <button type="button" className="btn btn-g" onClick={() => setFlow({ eyebrow: msg('{0} · 还原工具', {0: i.projectName ?? ''}), title: msg('按清单还原工具'), run: (dryRun, o) => api.install(pid, { dryRun, adopt: o.adopt, force: o.force, strict: o.strict }), writeOptions: ['strict', 'adopt', 'force'] })}>
          {msg('还原工具')}
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
        cap={msg("已检查 {0} 个项目 · {1} 更新", {0: report.projects.length, 1: hhmm(report.checkedAt)})}
        title={msg("体检")}
        actions={
          <>
            <button type="button" className="btn btn-g" onClick={measure}>
              {msg("重新检查")}</button>
            <button type="button" className="btn btn-p" disabled={!fixable.length} onClick={() => fix(fixable)}>
              {fixable.length ? msg("自动修复（{0}）", {0: fixable.length}) : msg("暂无可自动修复项")}
            </button>
          </>
        }
      />

      <div className="statbar" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
        <div className="flex items-center gap-3">
          <LevelGlyph level={errors.length ? 'error' : 'ok'} size={10} />
          <span className="flex flex-col gap-0.5">
            <span className="mono text-[22px] font-medium">{errors.length}</span>
            <span className="text-[12px] text-ink2">{errText}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <LevelGlyph level="warn" size={10} />
          <span className="flex flex-col gap-0.5">
            <span className="mono text-[22px] font-medium">{warns.length}</span>
            <span className="text-[12px] text-ink2">{warns.length ? msg("警告 · 需要确认") : msg("警告 · 未发现")}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <LevelGlyph level="info" size={10} />
          <span className="flex flex-col gap-0.5">
            <span className="mono text-[22px] font-medium">{infos.length}</span>
            <span className="text-[12px] text-ink2">{msg('提示 · 供参考')}</span>
          </span>
        </div>
      </div>

      {(errors.length > 0 || report.projects.length > 0) && <Section level="error">
        {errors.length === 0 && (
          <div className="flex flex-wrap items-center gap-3 px-3.5 py-3 text-[14px]" style={{ background: 'var(--ok-soft)' }}>
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-white" style={{ background: 'var(--ok)' }}>
              <Check size={13} strokeWidth={3} aria-hidden />
            </span>
            <span>{fixedNote ? <Rich text={msg("已重建链接 {0}，未发现其他错误", {0: fixedNote})} /> : msg("未发现错误")}</span>
          </div>
        )}
        {errors.map((i, idx) => (
          <div key={i.id} className={`hover-row flex flex-wrap items-center gap-4 px-3.5 py-3 ${idx < errors.length - 1 ? 'border-b border-line' : ''}`}>
            <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <ProjectRef issue={i} link={false} />
                {i.kind && <KindChip kind={i.kind} />}
                <strong className="text-[15px]">{doctorCopy(i, report).title}</strong>
                {i.name && <span className="mono text-[12px] text-ink2">{i.name}</span>}
              </div>
              <p className="m-0 text-[13px] leading-[1.6] text-ink2">{doctorCopy(i, report).detail}</p>
              <DiagnosticDetails issue={i} />
            </div>
            {i.fixable && (
              <button type="button" className="btn btn-g" onClick={() => fix([i])}>
                {i.code === 'broken-link' || i.code === 'missing-link' ? msg("重建软链") : msg("修复")}
              </button>
            )}
            {i.code === 'project-missing' && i.projectId && (
              <Link to={`/projects/${i.projectId}`} className="btn btn-g">
                {msg("重新定位…")}</Link>
            )}
          </div>
        ))}
      </Section>}

      {warns.length > 0 && (
        <Section level="warn">
          {warns.map((i, idx) => (
            <div key={i.id} className={`hover-row flex flex-wrap items-center gap-4 px-3.5 py-3 ${idx < warns.length - 1 ? 'border-b border-line' : ''}`}>
              <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <ProjectRef issue={i} link />
                  {i.kind && <KindChip kind={i.kind} />}
                  <strong className="text-[15px]">{doctorCopy(i, report).title}</strong>
                  {i.name && <span className="mono text-[12px] text-ink2">{i.name}</span>}
                </div>
                <p className="m-0 text-[13px] leading-[1.6] text-ink2">{doctorCopy(i, report).detail}</p>
                <DiagnosticDetails issue={i} />
              </div>
              <div className="flex flex-wrap gap-2">{warnActions(i)}</div>
            </div>
          ))}
        </Section>
      )}

      {infos.length > 0 && (
        <Section level="info">
          {infos.map((i, idx) => (
            <div key={i.id} className={`hover-row flex flex-wrap items-center gap-4 px-3.5 py-3 ${idx < infos.length - 1 ? 'border-b border-line' : ''}`}>
              <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <ProjectRef issue={i} link />
                  <span className="text-[14px]">{doctorCopy(i, report).title}</span>
                  {i.name && <span className="mono text-[12px] text-ink2">{i.name}</span>}
                </div>
                <p className="m-0 text-[12px] text-ink3">{doctorCopy(i, report).detail}</p>
                <DiagnosticDetails issue={i} />
              </div>
              {infoAction(i)}
            </div>
          ))}
        </Section>
      )}

      {report.projects.length === 0 && <Empty className="glass rounded-[8px]">{msg("暂无项目可检查。添加项目后，可查看工具链接、配置和上下文占用情况。")}</Empty>}

      <OpFlow config={flow} onClose={() => setFlow(null)} />
      {repo && <RepoDialog repo={repo} onClose={() => setRepo(null)} />}
      {migrate?.name && (
        <MigrateFlow onClose={() => setMigrate(null)} kind="plugin" name={migrate.name} suggested={migrate.projectId ? [migrate.projectId] : []} />
      )}
    </>
  );
}

