import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Minimal accessible modal: portal, scrim, Esc to close, initial focus + focus restore, Tab trap.
 * Visual: glass-strong + iridescent border + pop (prototype 03).
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  maxWidth = 1080,
  children,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  maxWidth?: number;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab' && node) {
        const f = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const a = f[0]!;
        const z = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-6 md:py-12" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* scrim is a sibling (not an ancestor) of the dialog so the dialog's backdrop-filter blurs the page */}
      <div aria-hidden className="pointer-events-none fixed inset-0" style={{ background: 'var(--scrim)', animation: 'fade .25s ease backwards' }} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`glass iri pop relative flex w-full flex-col rounded-[24px] outline-none ${className}`}
        style={{ maxWidth, background: 'var(--glass-dialog)', boxShadow: '0 32px 80px rgba(10,14,30,.35), inset 0 1px 0 var(--hi)' }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Simple dialog with header / body / footer for small forms. */
export function SimpleDialog({
  open,
  onClose,
  cap,
  title,
  children,
  footer,
  maxWidth = 560,
}: {
  open: boolean;
  onClose: () => void;
  cap?: string;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
}) {
  const id = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={id} maxWidth={maxWidth}>
      <header className="flex items-start gap-4 border-b border-line px-[26px] py-[22px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {cap && <span className="cap">{cap}</span>}
          <h1 id={id} className="m-0 text-[22px] font-bold">
            {title}
          </h1>
        </div>
        <button type="button" aria-label="关闭" className="btn btn-t btn-lg !w-11 !p-0" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </header>
      <div className="flex flex-col gap-4 px-[26px] py-[22px]">{children}</div>
      {footer && <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-[26px] py-[18px]">{footer}</footer>}
    </Dialog>
  );
}
