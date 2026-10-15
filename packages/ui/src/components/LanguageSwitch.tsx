import { Languages } from 'lucide-react';
import { useLocale, setLocale } from '../lib/i18n';

export function LanguageSwitch() {
  const locale = useLocale();
  return <div className="language-switch" role="group" aria-label="Language / 语言">
    <Languages size={14} aria-hidden />
    <button type="button" lang="zh-CN" aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
    <span aria-hidden>/</span>
    <button type="button" lang="en" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>English</button>
  </div>;
}
