import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { Dialog } from './Dialog';
import { DiffTabs } from './DiffView';
import { Empty, ErrorBox, LevelGlyph, Loading, Rich } from './ui';
import type { WritePreview } from '../lib/changes';
import { fileStat } from '../lib/changes';

export type FlowStep = 'select' | 'preview' | 'write';

/** CLI flags the user can toggle on the preview step; passed to `preview` and `commit`. */
export interface WriteOpts {
  /** `--adopt`: take over hand-written entries with the same name */
  adopt: boolean;
  /** `--force`: overwrite conflicting directories / links */
  force: boolean;
  /** `install --strict`: fail instead of warn when lock and repo HEAD disagree */
  strict: boolean;
}

export const NO_OPTS: WriteOpts = { adopt: false, force: false, strict: false };

const OPTION_INFO: Record<keyof WriteOpts, { flag: string; label: string; hint: string }> = {
  adopt: { flag: '--adopt', label: '接管同名的手写条目', hint: 'Agent 配置里已有同名条目时，改由 atm 管理（不勾选会报 CONFLICT）' },
  force: { flag: '--force', label: '覆盖冲突', hint: '占用目标位置的软链或克隆目录会被替换' },
  strict: { flag: '--strict', label: '严格模式', hint: 'lock 的 commit 与共享仓库 HEAD 不一致时报错，而不是警告' },
};

export interface WriteFlowProps {
  open: boolean;
  onClose: () => void;
  /** e.g. "web-app · 添加工具" */
  eyebrow: string;
  title: ReactNode;
  /** Step 1. When omitted the flow opens on step 2 (selection happened elsewhere). */
  select?: { content: ReactNode; canContinue: boolean };
  /** Left column shown next to the diff (definition, agents, env vars, context impact). */
  aside?: ReactNode;
  /** Which CLI flags to offer (`--adopt` / `--force` / `--strict`). Omit for flows with no such conflicts. */
  writeOptions?: Array<keyof WriteOpts>;
  /** dryRun call(s). Re-run whenever `previewKey` or a write option changes. */
  preview: (o: WriteOpts) => Promise<WritePreview>;
  previewKey?: string;
  /** The real write (same call without dryRun). */
  commit: (o: WriteOpts) => Promise<unknown>;
  onCommitted?: () => void;
  footnote?: ReactNode;
}

const STEPS: Array<[FlowStep, string]> = [
  ['select', '选择'],
  ['preview', '预览 diff'],
  ['write', '写入'],
];

type PreviewState = { status: 'loading' } | { status: 'ready'; data: WritePreview } | { status: 'error'; error: unknown };
type WriteState = { status: 'writing' } | { status: 'done' } | { status: 'error'; error: unknown };

/** 添加工具 · diff 确认 — the shared 3-step modal (prototype 03). */
export function WriteFlow(props: WriteFlowProps) {
  const { open, onClose, eyebrow, title, select, aside, preview, previewKey = '', commit, onCommitted, footnote, writeOptions } = props;
  const qc = useQueryClient();
  const titleId = useId();
  const [step, setStep] = useState<FlowStep>(select ? 'select' : 'preview');
  const [pv, setPv] = useState<PreviewState>({ status: 'loading' });
  const [ws, setWs] = useState<WriteState>({ status: 'writing' });
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [wopts, setWopts] = useState<WriteOpts>(NO_OPTS);
  const optKey = writeOptions?.map((k) => (wopts[k] ? k : '')).join('|') ?? '';

  useEffect(() => {
    if (open) {
      setStep(select ? 'select' : 'preview');
      setWopts(NO_OPTS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || step !== 'preview') return;
    let alive = true;
    setPv({ status: 'loading' });
    previewRef.current(wopts).then(
      (data) => alive && setPv({ status: 'ready', data }),
      (error: unknown) => alive && setPv({ status: 'error', error }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, previewKey, optKey]);

  const data = pv.status === 'ready' ? pv.data : null;
  const n = data?.files.length ?? 0;

  const doCommit = async () => {
    setStep('write');
    setWs({ status: 'writing' });
    try {
      await commit(wopts);
      setWs({ status: 'done' });
      await qc.invalidateQueries();
      onCommitted?.();
    } catch (error) {
      setWs({ status: 'error', error });
    }
  };

  const stepIdx = STEPS.findIndex(([s]) => s === step);

  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <header className="flex flex-wrap items-center gap-4 border-b border-line px-[26px] py-[22px]">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5">
          <span className="cap">{eyebrow}</span>
          <h1 id={titleId} className="m-0 flex flex-wrap items-center gap-3 text-[24px] font-bold">
            {title}
          </h1>
        </div>
        <ol aria-label="步骤" className="m-0 flex list-none gap-1 rounded-full bg-line p-1 text-[13px]">
          {STEPS.map(([s, label], i) => {
            const cur = s === step;
            const done = i < stepIdx;
            return (
              <li
                key={s}
                aria-current={cur ? 'step' : undefined}
                className="flex h-8 items-center gap-1.5 rounded-full px-3"
                style={
                  cur
                    ? { background: 'var(--glass-strong)', fontWeight: 600, boxShadow: '0 1px 4px rgba(0,0,0,.08)' }
                    : { color: done ? 'var(--ink2)' : 'var(--ink3)' }
                }
              >
                <span className="mono" style={cur ? { color: 'var(--accent-ink)' } : undefined}>
                  {done ? <Check size={12} strokeWidth={3} aria-label="已完成" /> : i + 1}
                </span>
                {label}
              </li>
            );
          })}
        </ol>
        <button type="button" aria-label="关闭" className="btn btn-t btn-lg !w-11 !p-0" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </header>

      {step === 'select' && select && <div className="flex flex-col gap-5 px-[26px] py-[22px]">{select.content}</div>}

      {step === 'preview' && (
        <div className="flex flex-wrap">
          {aside && (
            <aside className="box-border flex flex-[4_1_300px] flex-col gap-[22px] border-line px-[26px] py-[22px] md:border-r">
              {aside}
            </aside>
          )}
          <section className="box-border flex min-w-0 flex-[7_1_520px] flex-col gap-3.5 px-[26px] py-[22px]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="m-0 text-[16px] font-semibold">
                将要写入的文件 <span className="font-normal text-ink3">· {data ? n : '…'}</span>
              </h2>
              <span className="chip" style={{ background: 'var(--mcp-soft)', color: 'var(--mcp-ink)', fontWeight: 500 }}>
                dryRun=1 · 尚未写入
              </span>
            </div>
            {writeOptions && writeOptions.length > 0 && (
              <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                <legend className="cap pb-1.5">写入选项</legend>
                {writeOptions.map((k) => (
                  <label key={k} className="flex items-start gap-2.5 text-[13px] leading-[1.5]">
                    <input type="checkbox" className="mt-[3px]" checked={wopts[k]} onChange={(e) => setWopts({ ...wopts, [k]: e.target.checked })} />
                    <span>
                      {OPTION_INFO[k].label} <code className="mono text-[12px] text-ink3">{OPTION_INFO[k].flag}</code>
                      <span className="block text-[12px] text-ink3">{OPTION_INFO[k].hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {pv.status === 'loading' && <Loading label="正在计算 diff（dryRun）…" className="!px-0" />}
            {pv.status === 'error' && <ErrorBox error={pv.error} />}
            {data && (
              <>
                {data.errors.map((e) => (
                  <ErrorBox key={e} error={new Error(e)} />
                ))}
                {n > 0 ? (
                  <DiffTabs key={previewKey} files={data.files} />
                ) : (
                  !data.errors.length && <Empty className="rounded-[16px] border border-line2 bg-glass-2">没有需要写入的文件：磁盘上已经是清单描述的状态。</Empty>
                )}
                {data.warnings.map((w) => (
                  <div key={w} className="flex gap-2.5 rounded-[12px] px-3.5 py-3 text-[13px] leading-[1.6]" style={{ background: 'var(--warn-soft)' }}>
                    <LevelGlyph level="warn" size={8} className="mt-[7px]" />
                    <span>
                      <Rich text={w} />
                    </span>
                  </div>
                ))}
              </>
            )}
            <p className="m-0 text-[12px] leading-[1.6] text-ink3">
              {footnote ?? '合并写入只改动 lock.managed 中列出的条目，文件里手写的 MCP 保持原样。写入采用临时文件 + rename，失败时清单与 lock 都不变。'}
            </p>
          </section>
        </div>
      )}

      {step === 'write' && (
        <div className="flex flex-col gap-4 px-[26px] py-[26px]">
          {ws.status === 'writing' && <Loading label={`正在写入 ${n} 个文件…`} className="!px-0" />}
          {ws.status === 'error' && <ErrorBox error={ws.error} />}
          {ws.status === 'done' && (
            <div className="morph flex flex-col gap-4">
              <div className="flex items-center gap-3 rounded-[14px] px-5 py-4 text-[14px]" style={{ background: 'var(--ok-soft)' }}>
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-white" style={{ background: 'var(--ok)' }}>
                  <Check size={13} strokeWidth={3} aria-hidden />
                </span>
                <span>
                  已写入 {n} 个文件{data?.warnings.length ? `，${data.warnings.length} 条提示请留意` : ''}
                </span>
              </div>
              {data && n > 0 && (
                <ul className="m-0 flex list-none flex-col p-0">
                  {data.files.map((f) => (
                    <li key={f.key} className="mono flex justify-between gap-3 border-b border-line py-2 text-[12px] text-ink2 last:border-0">
                      <span className="truncate">{f.projectName && !f.change.relPath.startsWith('~') ? `${f.projectName} · ${f.change.relPath}` : f.change.relPath}</span>
                      <span className="shrink-0">{fileStat(f.change)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-[26px] py-[18px]">
        <span className="mono mr-auto min-w-0 text-[12px] break-all text-ink3">
          {data?.commands.length ? `等价命令：${data.commands.join(' ; ')}` : ''}
        </span>
        {step === 'select' && select && (
          <>
            <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-p btn-lg" disabled={!select.canContinue} onClick={() => setStep('preview')}>
              下一步：预览 diff
            </button>
          </>
        )}
        {step === 'preview' && (
          <>
            {select && (
              <button type="button" className="btn btn-t btn-lg" onClick={() => setStep('select')}>
                上一步
              </button>
            )}
            <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-p btn-lg" disabled={!data || n === 0} onClick={() => void doCommit()}>
              写入 {data ? n : ''} 个文件
            </button>
          </>
        )}
        {step === 'write' && (
          <>
            {ws.status === 'error' && (
              <button type="button" className="btn btn-g btn-lg" onClick={() => setStep('preview')}>
                返回预览
              </button>
            )}
            <button type="button" className="btn btn-p btn-lg" disabled={ws.status === 'writing'} onClick={onClose}>
              完成
            </button>
          </>
        )}
      </footer>
    </Dialog>
  );
}
