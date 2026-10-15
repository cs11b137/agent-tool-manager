import { msg, useLocale } from '../lib/i18n';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, Loader2, X } from 'lucide-react';

export type ToastTone = 'info' | 'ok' | 'err' | 'running';

export interface Toast {
  id: string;
  title: string;
  detail?: string;
  tone: ToastTone;
  percent?: number;
  onCancel?: () => void;
}

interface ToastApi {
  push(t: Omit<Toast, 'id'> & { id?: string }): string;
  update(id: string, patch: Partial<Omit<Toast, 'id'>>): void;
  dismiss(id: string): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside <ToastProvider>');
  return c;
}

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) clearTimeout(tm);
    timers.current.delete(id);
  }, []);

  const schedule = useCallback(
    (id: string, tone: ToastTone) => {
      const old = timers.current.get(id);
      if (old) clearTimeout(old);
      if (tone === 'running') return;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), tone === 'err' ? 8000 : 4000),
      );
    },
    [dismiss],
  );

  const push = useCallback<ToastApi['push']>(
    (t) => {
      const id = t.id ?? `toast-${++seq}`;
      setToasts((ts) => [...ts.filter((x) => x.id !== id), { ...t, id }].slice(-4));
      schedule(id, t.tone);
      return id;
    },
    [schedule],
  );

  const update = useCallback<ToastApi['update']>(
    (id, patch) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      if (patch.tone) schedule(id, patch.tone);
    },
    [schedule],
  );

  const api = useMemo(() => ({ push, update, dismiss }), [push, update, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="glass toast pointer-events-auto flex items-start gap-3 rounded-[16px] px-4 py-3"
            style={{ background: 'var(--glass-strong)' }}
          >
            <span className="mt-0.5 shrink-0">
              {t.tone === 'running' ? (
                <Loader2 size={16} className="spin text-accent" aria-hidden />
              ) : t.tone === 'ok' ? (
                <CheckCircle2 size={16} className="text-ok" aria-hidden />
              ) : t.tone === 'err' ? (
                <CircleAlert size={16} className="text-err" aria-hidden />
              ) : (
                <span className="mt-1 block h-2 w-2 rounded-full bg-accent" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[14px] font-medium">{t.title}</span>
              {t.detail && <span className="text-[12px] leading-[1.5] break-words text-ink3">{t.detail}</span>}
              {t.tone === 'running' && t.percent !== undefined && (
                <span className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-line">
                  <span className="bar rounded-full bg-accent" style={{ width: `${t.percent}%` }} />
                </span>
              )}
            </div>
            {t.tone === 'running' && t.onCancel ? (
              <button type="button" className="btn btn-t btn-sm !h-7 !px-2 text-[12px]" onClick={t.onCancel}>
                {msg("取消")}</button>
            ) : (
              <button type="button" aria-label={msg("关闭通知")} className="btn btn-t !h-7 !w-7 !p-0" onClick={() => dismiss(t.id)}>
                <X size={14} aria-hidden />
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
