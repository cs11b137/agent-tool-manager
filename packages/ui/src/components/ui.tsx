import { msg, useLocale } from '../lib/i18n';
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { ContextBreakdown, DoctorCounts, DoctorLevel, ToolKind } from '../api/types';
import { KIND_LABEL, budgetPct, fmtTok } from '../lib/format';
import { ApiError } from '../api/client';

export function KindChip({ kind, className = '', style, children }: { kind: ToolKind; className?: string; style?: CSSProperties; children?: ReactNode }) {
  useLocale();
  return (
    <span className={`chip c-${kind} ${className}`} style={style}>
      {children ?? KIND_LABEL[kind]}
    </span>
  );
}

type Glyph = DoctorLevel | 'ok' | 'missing';

/** Level glyphs from the design system: error ● / warn ◆ / info ○ / ok ●. */
export function LevelGlyph({ level, size = 8, className = '' }: { level: Glyph; size?: number; className?: string }) {
  useLocale();
  const base: CSSProperties = { width: size, height: size, flexShrink: 0, display: 'inline-block', boxSizing: 'border-box' };
  if (level === 'warn') {
    const s = Math.round(size * 0.86);
    return <span aria-hidden className={className} style={{ ...base, width: s, height: s, borderRadius: Math.max(1, size / 8), background: 'var(--warn)', transform: 'rotate(45deg)' }} />;
  }
  if (level === 'info' || level === 'missing') {
    const color = level === 'info' ? 'var(--ink2)' : 'var(--ink3)';
    return <span aria-hidden className={className} style={{ ...base, width: size + 1, height: size + 1, borderRadius: '50%', border: `${size >= 10 ? 2 : 1.5}px solid ${color}` }} />;
  }
  return <span aria-hidden className={className} style={{ ...base, borderRadius: '50%', background: level === 'error' ? 'var(--err)' : 'var(--ok)' }} />;
}

export function worstLevel(c: DoctorCounts): 'error' | 'warn' | 'ok' {
  return c.error ? 'error' : c.warn ? 'warn' : 'ok';
}

/** "1 warn" / "1 error" / "ok" chip used on project cards. */
export function DoctorChip({ counts }: { counts: DoctorCounts }) {
  useLocale();
  const w = worstLevel(counts);
  const style: CSSProperties =
    w === 'error'
      ? { background: 'var(--err-soft)', color: 'var(--err-ink)' }
      : w === 'warn'
        ? { background: 'var(--warn-soft)', color: 'var(--warn-ink)' }
        : { background: 'var(--ok-soft)', color: 'var(--ok-ink)' };
  return (
    <span className="chip gap-1.5" style={style}>
      <LevelGlyph level={w} size={6} />
      {w === 'error' ? msg('{0} 项错误', {0: counts.error}) : w === 'warn' ? msg('{0} 项警告', {0: counts.warn}) : msg('正常')}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  useLocale();
  return (
    <button
      type="button"
      role="switch"
      className="sw"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/** Skill / MCP / 插件 segments against a 10k budget; hatched tail for unmeasured tools. */
export function ContextBar({ context, height = 8 }: { context: ContextBreakdown; height?: number }) {
  useLocale();
  return (
    <div className="flex overflow-hidden rounded-full bg-line" style={{ height, gap: 2 }}>
      {context.skill > 0 && <div className="bar" style={{ width: budgetPct(context.skill), background: 'var(--skill)' }} />}
      {context.mcp > 0 && <div className="bar" style={{ width: budgetPct(context.mcp), background: 'var(--mcp)' }} />}
      {context.plugin > 0 && <div className="bar" style={{ width: budgetPct(context.plugin), background: 'var(--plugin)' }} />}
      {context.unmeasured > 0 && (
        <div
          className="bar"
          title={msg("{0} 项未测量", {0: context.unmeasured})}
          style={{ width: '8%', background: 'repeating-linear-gradient(135deg, var(--line2) 0 3px, transparent 3px 6px)' }}
        />
      )}
    </div>
  );
}

export function ContextLegend({ context }: { context: ContextBreakdown }) {
  useLocale();
  const items: Array<[string, string, string]> = [
    ['var(--skill)', 'Skill', fmtTok(context.skill)],
    ['var(--mcp)', 'MCP', fmtTok(context.mcp)],
    ['var(--plugin)', msg("插件"), fmtTok(context.plugin)],
  ];
  return (
    <div className="flex flex-wrap gap-4 text-[12px] text-ink2">
      {items.map(([c, l, v]) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: c }} />
          {l} {v}
        </span>
      ))}
      {context.unmeasured > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span className="hatch h-2 w-2 rounded-full border border-line2" />
          {msg("{0} 项未测量", {0: context.unmeasured})}</span>
      )}
    </div>
  );
}

/** Renders `code` spans in plain strings as mono <code>. */
export function Rich({ text, codeClass = '' }: { text: string; codeClass?: string }) {
  useLocale();
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') && p.length > 1 ? (
          <code key={i} className={`mono ${codeClass}`}>
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function PageHeader({ cap, title, titleClass = '', sub, actions, crumb }: { cap?: ReactNode; title: ReactNode; titleClass?: string; sub?: ReactNode; actions?: ReactNode; crumb?: ReactNode }) {
  useLocale();
  return (
    <div className="rise flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        {crumb}
        {cap && <span className="cap">{cap}</span>}
        <h1 className={`ca m-0 text-[36px] leading-tight font-bold tracking-[-0.02em] ${titleClass}`}>{title}</h1>
        {sub}
      </div>
      {actions && <div className="flex flex-wrap items-end gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorBox({ error, className = '' }: { error: unknown; className?: string }) {
  useLocale();
  const e = error instanceof ApiError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={`flex gap-2.5 rounded-[12px] px-3.5 py-3 text-[13px] leading-[1.6] ${className}`} style={{ background: 'var(--err-soft)' }}>
      <LevelGlyph level="error" size={8} className="mt-[7px]" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>
          {e && <strong className="mono mr-1.5 text-[12px] text-err-ink">{e.code}</strong>}
          <Rich text={msg(message)} />
        </span>
        {e?.nextCommand && <span className="mono text-[12px] text-ink3">{msg("下一步：")}{e.nextCommand}</span>}
      </div>
    </div>
  );
}

export function Loading({ label = msg("加载中…"), className = '' }: { label?: string; className?: string }) {
  useLocale();
  return (
    <div className={`flex items-center gap-2 px-5 py-6 text-[13px] text-ink3 ${className}`}>
      <span className="spin inline-block h-3.5 w-3.5 rounded-full border-2 border-line2 border-t-accent" aria-hidden />
      {label}
    </div>
  );
}

export function Empty({ children, className = '' }: { children: ReactNode; className?: string }) {
  useLocale();
  return <div className={`px-5 py-6 text-[13px] leading-[1.6] text-ink3 ${className}`}>{children}</div>;
}

/** Sticky "N 项改动待提交" bar used by project detail and matrix. */
export function PendingBar({ label, sub, onReset, onApply, applyLabel, sticky = true }: { label: string; sub?: string; onReset: () => void; onApply: () => void; applyLabel: string; sticky?: boolean }) {
  useLocale();
  return (
    <div
      role="status"
      className={`glass iri toast z-20 flex flex-wrap items-center gap-3 rounded-[16px] py-3 pr-3.5 pl-5 ${sticky ? 'sticky bottom-4' : ''}`}
      style={{ background: 'var(--glass-strong)' }}
    >
      <span className="flex-[1_1_240px] text-[14px] font-medium">
        {label} {sub && <span className="font-normal text-ink3">· {sub}</span>}
      </span>
      <button type="button" className="btn btn-g" onClick={onReset}>
        {msg("撤销")}</button>
      <button type="button" className="btn btn-p" onClick={onApply}>
        {applyLabel}
      </button>
    </div>
  );
}
