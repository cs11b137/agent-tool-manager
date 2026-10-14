import type { CSSProperties, ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useDoctor, useProjects } from '../api/queries';
import { useApi } from '../api/context';
import { useTheme } from '../lib/theme';
import { useConnection } from './LiveProvider';
import { AtmMark } from './AtmMark';
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

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <AtmMark size={32} className="shrink-0" />
      <strong className="text-[15px] leading-tight">Agent Tool Manager</strong>
    </div>
  );
}

function ThemeToggle() {
  const { pref, cycle } = useTheme();
  const label = pref === 'system' ? '跟随系统' : pref === 'light' ? '浅色' : '深色';
  const Icon = pref === 'system' ? Monitor : pref === 'light' ? Sun : Moon;
  return (
    <button type="button" className="btn btn-t !h-7 !w-7 !rounded-[8px] !p-0" aria-label={`主题：${label}（点击切换）`} title={`主题：${label}`} onClick={cycle}>
      <Icon size={14} aria-hidden />
    </button>
  );
}

const NAV: Array<{ to: string; label: string; end?: boolean }> = [
  { to: '/', label: '总览', end: true },
  { to: '/library', label: '工具库' },
  { to: '/matrix', label: '矩阵' },
  { to: '/doctor', label: '体检' },
  { to: '/global', label: '全局' },
];

function useNavBadges() {
  const doctor = useDoctor();
  const errors = doctor.data?.counts.error ?? 0;
  return { errors };
}

function NavItems({ compact = false }: { compact?: boolean }) {
  const { errors } = useNavBadges();
  return (
    <>
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end ?? false} className={({ isActive }) => `nv ${isActive ? 'on' : ''} ${compact ? '!min-h-9' : ''}`}>
          <span className="dot" />
          {n.label}
          {n.to === '/doctor' && errors > 0 && (
            <span className="chip ml-auto" style={{ background: 'var(--err-soft)', color: 'var(--err-ink)' }} aria-label={`${errors} 个 error`}>
              {errors}
            </span>
          )}
        </NavLink>
      ))}
    </>
  );
}

function ProjectNav() {
  const { data: projects } = useProjects();
  return (
    <div className="flex min-h-0 flex-col gap-0.5">
      <span className="cap px-3 pb-1.5">项目</span>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {projects?.map((p) => {
          const lvl = p.exists ? worstLevel(p.doctor) : 'missing';
          const style: CSSProperties = p.exists ? { fontSize: 13, color: 'var(--ink)' } : { fontSize: 13, color: 'var(--ink3)', textDecoration: 'line-through' };
          return (
            <NavLink
              key={p.id}
              to={`/projects/${p.id}`}
              className={({ isActive }) => `nv mono ${isActive ? 'on' : ''}`}
              style={style}
              title={p.exists ? p.path : `${p.path}（目录不存在）`}
            >
              <LevelGlyph level={lvl} size={lvl === 'missing' ? 7 : 7} />
              <span className="truncate">{p.name}</span>
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}

function ConnectionFooter() {
  const status = useConnection();
  const api = useApi();
  const host = typeof window !== 'undefined' ? window.location.host : '';
  const [color, text] =
    status === 'open' ? ['var(--ok)', '已连接 · 实时同步'] : status === 'connecting' ? ['var(--warn)', '连接中…'] : ['var(--err)', '已断开 · 正在重连'];
  return (
    <div className="mt-auto flex flex-col gap-1 border-t border-line px-3 pt-3.5 pb-1 text-[12px] text-ink3">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        {text}
        {api.kind === 'mock' && <span className="chip c-muted ml-auto !h-[18px] !px-1.5 !text-[10px]">mock</span>}
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className="mono truncate" title={api.kind === 'mock' ? 'VITE_ATM_MOCK=1：使用内存中的演示数据' : undefined}>
          {host}
        </span>
        <ThemeToggle />
      </span>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const page = pageOf(loc.pathname);
  return (
    <div className="relative isolate min-h-screen">
      <MeshBackground page={page} />
      <div className="relative z-[1] flex min-h-screen flex-col gap-4 p-4 md:flex-row">
        {/* ≥768: glass sidebar */}
        <nav
          aria-label="主导航"
          className="glass sticky top-4 hidden h-[calc(100vh-32px)] w-[220px] shrink-0 flex-col gap-[22px] rounded-[20px] px-3 py-5 md:flex"
        >
          <Logo />
          <div className="flex flex-col gap-0.5">
            <NavItems />
          </div>
          <ProjectNav />
          <ConnectionFooter />
        </nav>
        {/* <768: top nav */}
        <nav aria-label="主导航" className="glass sticky top-2 z-30 flex items-center gap-2 rounded-[16px] px-2 py-2 md:hidden">
          <span
            className="mono flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[12px] font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, #0066FF, #8E6CFF)' }}
          >
            atm
          </span>
          <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
            <NavItems compact />
          </div>
          <ThemeToggle />
        </nav>
        <main className="min-w-0 flex-1 px-0 py-2 md:px-2 md:py-4">
          <div key={loc.pathname} className="page mx-auto flex w-full max-w-[1280px] flex-col gap-5">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
