import { useSyncExternalStore } from 'react';
import en from '../locales/en.json';
import zh from '../locales/zh.json';

export type Locale = 'zh-CN' | 'en';
const KEY = 'atm.locale';
const listeners = new Set<() => void>();
function readLocale(): Locale {
  try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}
let locale: Locale = readLocale();
const applyDocumentLanguage = () => {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
};
applyDocumentLanguage();
export function setLocale(next: Locale) {
  locale = next;
  try { localStorage.setItem(KEY, next); } catch { /* In-memory switching still works. */ }
  applyDocumentLanguage();
  listeners.forEach((listener) => listener());
}
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== KEY && event.key !== null) return;
  locale = readLocale();
  applyDocumentLanguage();
  listeners.forEach((listener) => listener());
});
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, () => locale, () => 'zh-CN');
}
/** Localize explicit UI messages only. Never pass user tool names, paths, or source files here. */
export function msg(key: string, values: Record<string, string | number | undefined> = {}): string {
  const catalog: Record<string, string> = locale === 'en' ? en : zh;
  const text = catalog[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] === undefined ? match : String(values[name]));
}
