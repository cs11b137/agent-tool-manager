import { msg, useLocale } from '../lib/i18n';
import { Link } from 'react-router';
import { PageHeader } from '../components/ui';

export function NotFoundPage() {
  useLocale();
  return (
    <>
      <PageHeader cap="404" title={msg("找不到这个页面")} />
      <p className="m-0 text-[14px] text-ink2">
        <Link to="/">{msg("回到总览 →")}</Link>
      </p>
    </>
  );
}
