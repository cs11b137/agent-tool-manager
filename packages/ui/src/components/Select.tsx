import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/** Select-only combobox: focus stays on the trigger while navigating options. */
export function Select<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [above, setAbove] = useState(false);
  const expanded = open && !disabled;
  const selected = options.findIndex((option) => option.value === value);

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [expanded]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (expanded) document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, expanded, id]);

  const show = (index = Math.max(0, selected)) => {
    const bounds = root.current?.getBoundingClientRect();
    const height = Math.min(options.length * 36 + 14, 240);
    setAbove(!!bounds && window.innerHeight - bounds.bottom < height && bounds.top > height);
    search.current = { text: '', time: 0 };
    setActive(index);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option) onChange(option.value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : Math.max(0, Math.min(options.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
      if (!expanded) show(event.key === 'Home' || event.key === 'End' ? next : Math.max(0, selected));
      else setActive(next);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (expanded) choose(active);
      else show();
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const query = (now - search.current.time < 700 ? search.current.text : '') + event.key.toLocaleLowerCase();
      const match = options.findIndex((option) => option.label.toLocaleLowerCase().startsWith(query));
      if (!expanded) show(match >= 0 ? match : Math.max(0, selected));
      else if (match >= 0) setActive(match);
      search.current = { text: query, time: now };
    }
  };

  return <div ref={root} className="select-field flex flex-col gap-1.5" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <label id={`${id}-label`} htmlFor={id}>{label}</label>
    <button id={id} type="button" role="combobox" className="input select-trigger"
      aria-labelledby={`${id}-label`} aria-expanded={expanded} aria-haspopup="listbox"
      aria-controls={expanded ? `${id}-list` : undefined}
      aria-activedescendant={expanded ? `${id}-option-${active}` : undefined}
      disabled={disabled} onKeyDown={onKeyDown} onClick={() => expanded ? setOpen(false) : show()}>
      <span>{options[selected]?.label}</span><ChevronDown size={16} aria-hidden className="select-chevron" />
    </button>
    {expanded && <div id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}
      className={`select-menu${above ? ' select-menu-above' : ''}`}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`}
        role="option" aria-selected={option.value === value} className="select-option"
        data-active={index === active} onPointerMove={() => setActive(index)}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span><Check size={16} aria-hidden className="select-check" />
      </div>)}
    </div>}
  </div>;
}
