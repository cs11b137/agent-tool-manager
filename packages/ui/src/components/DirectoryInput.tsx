import { msg, useLocale } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useApi } from '../api/context';

/** Native selection fills the same controlled field as typing; it never saves or registers. */
export function DirectoryInput({ id, value, onChange, disabled = false, placeholder, autoFocus = false, onPickingChange }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  onPickingChange: (picking: boolean) => void;
}) {
  useLocale();
  const api = useApi();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choose = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    setPicking(true); setError(''); onPickingChange(true);
    try {
      const result = await api.selectDirectory(value || undefined);
      if (mounted.current && result.path !== null) onChange(result.path);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : msg("选择失败，请重试或手动输入路径"));
    } finally {
      pending.current = false;
      if (mounted.current) { setPicking(false); onPickingChange(false); }
    }
  };
  return <>
    <div className="flex flex-wrap gap-2">
      <input id={id} data-autofocus={autoFocus || undefined} className="input input-lg mono min-w-0 flex-[1_1_220px]" value={value} onChange={(e) => { setError(''); onChange(e.target.value); }} placeholder={placeholder} spellCheck={false} disabled={disabled || picking} aria-describedby={error ? `${id}-error` : undefined} />
      <button type="button" className="btn btn-g shrink-0" disabled={disabled || picking} onClick={() => void choose()}><FolderOpen size={16} aria-hidden />{picking ? msg("选择中…") : msg("选择文件夹…")}</button>
    </div>
    {error && <p id={`${id}-error`} role="alert" className="m-0 text-xs leading-6 text-err-ink">{msg(error)}</p>}
  </>;
}
