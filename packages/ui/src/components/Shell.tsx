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

type Blob = [w: number, h: number, top: number, left: number, color: 'b1' | 'b2' | 'b3' | 'b4'];

/** Blob layouts per page, from each prototype's `.mesh`. */
const MESH: Record<string, Blob[]> = {
  overview: [[46, 60, -18, 30, 'b1'], [38, 55, 10, 70, 'b2'], [40, 50, 55, -6, 'b3'], [36, 45, 70, 60, 'b4']],
  project: [[44, 56, -20, 45, 'b1'], [36, 50, 30, 75, 'b2'], [42, 52, 50, 5, 'b3'], [30, 40, 75, 50, 'b4']],
  doctor: [[40, 55, -15, 40, 'b4'], [40, 55, 15, 72, 'b1'], [40, 50, 55, 10, 'b2'], [32, 42, 75, 60, 'b3']],
  matrix: [[42, 55, -15, 55, 'b2'], [40, 55, 30, 15, 'b1'], [38, 50, 60, 65, 'b3'], [30, 40, 80, 30, 'b4']],
  library: [[40, 55, -15, 25, 'b3'], [40, 55, 5, 68, 'b1'], [38, 50, 60, 10, 'b2'], [34, 45, 65, 70, 'b4']],
  global: [[44, 55, -18, 35, 'b2'], [38, 50, 18, 72, 'b3'], [40, 50, 58, 0, 'b1'], [30, 40, 76, 58, 'b4']],
};

function pageOf(pathname: string): string {
  if (pathname.startsWith('/projects/')) return 'project';
  const seg = pathname.split('/')[1] ?? '';
  return seg in MESH ? seg : 'overview';
}

export function MeshBackground({ page }: { page: string }) {
  useLocale();
  const blobs = MESH[page] ?? MESH.overview!;
  return (
    <div className="mesh" aria-hidden="true">
      {blobs.map(([w, h, top, left, c], i) => (
        <div
          key={i}
          className={`blob ${i === 1 ? 'b2' : i === 2 ? 'b3' : ''}`}
          style={{ width: `${w}%`, height: `${h}%`, top: `${top}%`, left: `${left}%`, background: `var(--${c})` }}
        />
      ))}
    </div>
  );
}


function ThemeToggle() {
  useLocale();
  const { pref, cycle } = useTheme();
  const label = msg(pref === 'system' ? '跟随系统' : pref === 'light' ? '浅色' : '深色');
  const Icon = pref === 'system' ? Monitor : pref === 'light' ? Sun : Moon;
  return <button type="button" className="sidebar-icon-button" aria-label={msg('主题：{0}（点击切换）', {0: label})} title={msg('主题：{0}', {0: label})} onClick={cycle}><Icon size={17} aria-hidden /></button>;
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

function SidebarContent({ onAdd, onSettings, onNavigate }: { onAdd: () => void; onSettings: () => void; onNavigate?: () => void }) {
  useLocale();
  const { data: projects = [], error } = useProjects();
  const doctor = useDoctor();
  const config = useConfig();
  const status = useConnection();
  const api = useApi();
  const [search, setSearch] = useState('');
  const visible = projects.filter((p) => (p.name + ' ' + p.path).toLowerCase().includes(search.toLowerCase()));
  const root = config.data?.root;
  const repositoryName = root?.split(/[\\/]/).filter(Boolean).pop() ?? 'agent-tools';
  const errors = doctor.data?.counts.error ?? 0;
  const links = (items: typeof PRIMARY) => items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={onNavigate} className={({isActive}) => `sidebar-link ${isActive ? 'is-active' : ''}`}>
    <Icon size={18} aria-hidden /><span>{msg(label)}</span>
    {to === '/doctor' && errors > 0 && <span className="sidebar-badge error" aria-label={msg('{0} 项错误', {0: errors})}>{errors}</span>}
  </NavLink>);
  return <>
    <div className="sidebar-brand"><AtmMark size={34} /><div><strong>Agent Tools</strong><span>{msg('集中管理，按需关联')}</span></div></div>
    <LanguageSwitch />
    <button type="button" className="repository-switch" onClick={onSettings} title={root}>
      <span className="repository-avatar"><Folder size={17} aria-hidden /></span>
      <span className="min-w-0 flex-1 text-left"><span className="block text-[11px] text-ink3">{msg('共享仓库')}</span><strong className="block truncate text-[13px] font-medium">{repositoryName}</strong></span>
      <ChevronRight size={15} aria-hidden />
    </button>
    <div className="sidebar-section"><span className="sidebar-heading">{msg('工作区')}</span>{links(PRIMARY)}</div>
    <div className="sidebar-projects">
      <div className="flex items-center justify-between px-2"><span className="sidebar-heading !p-0">{msg('项目')} <span className="ml-1 opacity-60">{projects.length}</span></span><button type="button" className="sidebar-icon-button" aria-label={msg('添加项目')} title={msg('添加项目')} onClick={onAdd}><Plus size={16} aria-hidden /></button></div>
      {projects.length > 0 && <label className="sidebar-search"><Search size={14} aria-hidden /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={msg('搜索项目')} aria-label={msg('搜索项目')} /></label>}
      <div className="sidebar-project-list">
        {visible.map((p) => <NavLink key={p.id} to={`/projects/${p.id}`} onClick={onNavigate} title={p.path} className={({isActive}) => `sidebar-link project-link ${isActive ? 'is-active' : ''}`}>
          <Folder size={15} aria-hidden /><span className={`truncate ${p.exists ? '' : 'text-ink3 line-through'}`}>{p.name}</span><LevelGlyph level={p.exists ? worstLevel(p.doctor) : 'missing'} size={6} />
        </NavLink>)}
        {!projects.length && !error && <div className="sidebar-empty"><span>{msg('还没有项目')}</span><p>{msg('添加项目文件夹，再关联需要的工具。')}</p><button className="sidebar-add" type="button" onClick={onAdd}><Plus size={14} aria-hidden />{msg('添加项目')}</button></div>}
        {error && <p className="px-2 text-xs text-err-ink">{msg('无法加载项目')}</p>}
        {projects.length > 0 && !visible.length && <p className="px-2 text-xs text-ink3">{msg('没有匹配的项目')}</p>}
      </div>
    </div>
    <div className="sidebar-section"><span className="sidebar-heading">{msg('维护')}</span>{links(MAINTENANCE)}</div>
    <div className="sidebar-footer">
      <div className="flex items-center gap-1"><button type="button" className="sidebar-link flex-1" onClick={onSettings}><Settings size={17} aria-hidden /><span>{msg('设置')}</span></button><ThemeToggle /></div>
      <span className="sidebar-connection" role="status"><span style={{background: status === 'open' ? 'var(--ok)' : 'var(--warn)'}} />{msg(status === 'open' ? '已连接 · 实时同步' : status === 'connecting' ? '连接中…' : '已断开 · 正在重连')}{api.kind === 'mock' && <span> · Demo</span>}</span>
    </div>
  </>;
}

export function Shell({ children }: { children: ReactNode }) {
  useLocale();
  const loc = useLocation();
  const [mobile, setMobile] = useState(false);
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(false);
  const openSettings = () => { setMobile(false); setSettings(true); };
  const openAdd = () => { setMobile(false); setAdding(true); };
  return <div className="relative isolate min-h-screen">
    <MeshBackground page={pageOf(loc.pathname)} />
    <a href="#main-content" className="skip-link">{msg('跳转到主内容')}</a>
    <div className="relative z-[1] flex min-h-screen flex-col gap-5 p-3 md:flex-row md:p-4">
      <nav aria-label={msg('主导航')} className="glass sidebar hidden md:flex"><SidebarContent onAdd={openAdd} onSettings={openSettings} /></nav>
      <header className="glass mobile-header md:hidden"><button type="button" className="sidebar-icon-button" onClick={() => setMobile(true)} aria-label={msg('打开导航')} aria-expanded={mobile}><Menu size={20} aria-hidden /></button><AtmMark size={26} /><strong className="mr-auto text-sm">Agent Tools</strong><LanguageSwitch /></header>
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-0 py-2 md:px-2 md:py-4"><div key={loc.pathname} className="page mx-auto flex w-full max-w-[1280px] flex-col gap-5">{children}</div></main>
    </div>
    {mobile && <SimpleDialog open title={msg('导航')} onClose={() => setMobile(false)}><nav className="mobile-sidebar" aria-label={msg('主导航')}><SidebarContent onAdd={openAdd} onSettings={openSettings} onNavigate={() => setMobile(false)} /></nav></SimpleDialog>}
    {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    {adding && <RegisterProjectDialog onClose={() => setAdding(false)} />}
  </div>;
}
