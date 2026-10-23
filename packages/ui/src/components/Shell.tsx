import { LanguageSwitch } from './LanguageSwitch';
import { msg, useLocale } from '../lib/i18n';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useState } from 'react';
import { Monitor, Moon, Settings, Sun, LayoutDashboard, Library, Grid2X2, HeartPulse, HardDrive, Folder, Plus, Search, Menu, ChevronRight } from 'lucide-react';
import { useDoctor, useProjects, useConfig } from '../api/queries';
import { useApi } from '../api/context';
import { useTheme } from '../lib/theme';
import { useConnection } from './LiveProvider';
import { SimpleDialog } from './Dialog';
import { AtmMark } from './AtmMark';
import { SettingsDialog, RegisterProjectDialog } from './dialogs';
import { LevelGlyph, worstLevel } from './ui';

function ThemeToggle() {
  useLocale();
  const { pref, cycle } = useTheme();
  const label = msg(pref === 'system' ? '跟随系统' : pref === 'light' ? '浅色' : '深色');
  const Icon = pref === 'system' ? Monitor : pref === 'light' ? Sun : Moon;
  return <button type="button" className="sidebar-icon-button" aria-label={msg('主题：{0}（点击切换）', {0: label})} title={msg('主题：{0}', {0: label})} onClick={cycle}><Icon size={14} aria-hidden /></button>;
}

const PRIMARY = [
  { to: '/', label: '总览', icon: LayoutDashboard },
  { to: '/library', label: '工具库', icon: Library },
  { to: '/matrix', label: '矩阵', icon: Grid2X2 },
];
const MAINTENANCE = [
  { to: '/doctor', label: '体检', icon: HeartPulse },
  { to: '/global', label: '全局', icon: HardDrive },
];

/** 顶栏面包屑的当前页名（mono）：静态路由取 label，项目页取项目名。 */
function useCrumbLeaf(pathname: string): string {
  const { data: projects = [] } = useProjects();
  if (pathname.startsWith('/projects/')) {
    const id = pathname.split('/')[2] ?? '';
    return projects.find((p) => p.id === id)?.name ?? msg('项目');
  }
  return [...PRIMARY, ...MAINTENANCE].find((l) => (l.to === '/' ? pathname === '/' : pathname.startsWith(l.to)))?.label ?? msg('总览');
}

function SidebarContent({ onAdd, onSettings, onNavigate }: { onAdd: () => void; onSettings: () => void; onNavigate?: () => void }) {
  useLocale();
  const { data: projects = [], error } = useProjects();
  const doctor = useDoctor();
  const config = useConfig();
  const [search, setSearch] = useState('');
  const visible = projects.filter((p) => (p.name + ' ' + p.path).toLowerCase().includes(search.toLowerCase()));
  const root = config.data?.root;
  const repositoryName = root?.split(/[\\/]/).filter(Boolean).pop() ?? 'agent-tools';
  const errors = doctor.data?.counts.error ?? 0;
  const links = (items: typeof PRIMARY) => items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={onNavigate} className={({isActive}) => `sidebar-link ${isActive ? 'is-active' : ''}`}>
    <Icon size={15} aria-hidden /><span>{msg(label)}</span>
    {to === '/doctor' && errors > 0 && <span className="sidebar-badge error" aria-label={msg('{0} 项错误', {0: errors})}>{errors}</span>}
  </NavLink>);
  return <>
    <div className="sidebar-brand"><AtmMark size={22} /><div><strong>Agent Tools</strong><span>{msg('集中管理，按需关联')}</span></div></div>
    <LanguageSwitch />
    <button type="button" className="repository-switch" onClick={onSettings} title={root}>
      <span className="repository-avatar"><Folder size={14} aria-hidden /></span>
      <span className="min-w-0 flex-1 text-left"><span className="block text-[11px] text-ink3">{msg('共享仓库')}</span><strong className="block truncate text-[12.5px] font-medium">{repositoryName}</strong></span>
      <ChevronRight size={13} aria-hidden />
    </button>
    <div className="sidebar-section"><span className="sidebar-heading">{msg('工作区')}</span>{links(PRIMARY)}</div>
    <div className="sidebar-projects">
      <div className="flex items-center justify-between px-2"><span className="sidebar-heading !p-0">{msg('项目')} <span className="ml-1 opacity-60">{projects.length}</span></span><button type="button" className="sidebar-icon-button" aria-label={msg('添加项目')} title={msg('添加项目')} onClick={onAdd}><Plus size={14} aria-hidden /></button></div>
      {projects.length > 0 && <label className="sidebar-search"><Search size={12} aria-hidden /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={msg('搜索项目')} aria-label={msg('搜索项目')} /></label>}
      <div className="sidebar-project-list">
        {visible.map((p) => <NavLink key={p.id} to={`/projects/${p.id}`} onClick={onNavigate} title={p.path} className={({isActive}) => `sidebar-link project-link ${isActive ? 'is-active' : ''}`}>
          <Folder size={13} aria-hidden /><span className={`truncate ${p.exists ? '' : 'text-ink3 line-through'}`}>{p.name}</span><LevelGlyph level={p.exists ? worstLevel(p.doctor) : 'missing'} size={6} />
        </NavLink>)}
        {!projects.length && !error && <div className="sidebar-empty"><span>{msg('还没有项目')}</span><p>{msg('添加项目文件夹，再关联需要的工具。')}</p><button className="sidebar-add" type="button" onClick={onAdd}><Plus size={13} aria-hidden />{msg('添加项目')}</button></div>}
        {error && <p className="px-2 text-xs text-err-ink">{msg('无法加载项目')}</p>}
        {projects.length > 0 && !visible.length && <p className="px-2 text-xs text-ink3">{msg('没有匹配的项目')}</p>}
      </div>
    </div>
    <div className="sidebar-section"><span className="sidebar-heading">{msg('维护')}</span>{links(MAINTENANCE)}</div>
    <div className="sidebar-footer">
      <div className="flex items-center gap-1"><button type="button" className="sidebar-link flex-1" onClick={onSettings}><Settings size={14} aria-hidden /><span>{msg('设置')}</span></button><ThemeToggle /></div>
    </div>
  </>;
}

export function Shell({ children }: { children: ReactNode }) {
  useLocale();
  const loc = useLocation();
  const [mobile, setMobile] = useState(false);
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(false);
  const status = useConnection();
  const api = useApi();
  const config = useConfig();
  const leaf = useCrumbLeaf(loc.pathname);
  const repositoryName = config.data?.root?.split(/[\\/]/).filter(Boolean).pop() ?? 'agent-tools';
  const openSettings = () => { setMobile(false); setSettings(true); };
  const openAdd = () => { setMobile(false); setAdding(true); };
  return <div className="flex min-h-screen">
    <a href="#main-content" className="skip-link">{msg('跳转到主内容')}</a>
    <nav aria-label={msg('主导航')} className="sidebar hidden md:flex"><SidebarContent onAdd={openAdd} onSettings={openSettings} /></nav>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="topbar hidden md:flex">
        <span className="topbar-crumb">{repositoryName}<ChevronRight size={11} aria-hidden /><b>{leaf}</b></span>
        <span className="topbar-right">
          <span className="topbar-status" role="status">
            <i style={{ background: status === 'open' ? 'var(--ok)' : 'var(--warn)' }} />
            {msg(status === 'open' ? '已连接 · 实时同步' : status === 'connecting' ? '连接中…' : '已断开 · 正在重连')}{api.kind === 'mock' && <span> · Demo</span>}
          </span>
        </span>
      </header>
      <header className="mobile-header md:hidden"><button type="button" className="sidebar-icon-button" onClick={() => setMobile(true)} aria-label={msg('打开导航')} aria-expanded={mobile}><Menu size={18} aria-hidden /></button><AtmMark size={22} /><strong className="mr-auto text-sm">Agent Tools</strong><LanguageSwitch /></header>
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-5 md:px-6"><div key={loc.pathname} className="page mx-auto flex w-full max-w-[1280px] flex-col gap-4">{children}</div></main>
    </div>
    {mobile && <SimpleDialog open title={msg('导航')} onClose={() => setMobile(false)}><nav className="mobile-sidebar" aria-label={msg('主导航')}><SidebarContent onAdd={openAdd} onSettings={openSettings} onNavigate={() => setMobile(false)} /></nav></SimpleDialog>}
    {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    {adding && <RegisterProjectDialog onClose={() => setAdding(false)} />}
  </div>;
}
