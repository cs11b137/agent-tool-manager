import { msg } from './i18n';
import type { AgentId, ToolKind } from '../api/types';

/** 184 → "184", 6084 → "6.1k" (project / overview style). */
export function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Table style used by matrix / library: 96 → "96", 300 → "0.3k". */
export function fmtTokShort(n: number | null): string {
  if (n === null) return '?';
  return n < 100 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** Bar width against the 10k-token budget, at least 1% when non-zero. */
export function budgetPct(n: number, budget = 10_000): string {
  if (n <= 0) return '0%';
  return `${Math.min(100, Math.max(1, (n / budget) * 100))}%`;
}

export const AGENT_LABEL: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
};

export const AGENT_MCP_FILE: Record<AgentId, string> = {
  'claude-code': '.mcp.json',
  cursor: '.cursor/mcp.json',
  codex: '.codex/config.toml',
};

export function agentsLabel(agents: AgentId[]): string {
  if (agents.length === 0) return msg("未落地");
  if (agents.length === 1) return msg("仅 {0}", {0: AGENT_LABEL[agents[0]!]});
  return agents.map((a) => AGENT_LABEL[a]).join(' · ');
}

export const KIND_LABEL: Record<ToolKind, string> = { skill: 'SKILL', mcp: 'MCP', plugin: 'PLUGIN' };
export const KIND_TITLE: Record<ToolKind, string> = { skill: 'Skill', mcp: 'MCP', plugin: '插件' };

/** Replace the home directory prefix with `~`. */
export function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

/** Plugins are stored as `name@marketplace`; show the short name. */
export function displayName(kind: ToolKind, name: string): string {
  if (kind !== 'plugin') return name;
  const at = name.indexOf('@');
  return at > 0 ? name.slice(0, at) : name;
}

export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function shortHash(h: string): string {
  return h.startsWith('sha256:') ? `${h.slice(0, 11)}…` : h.slice(0, 7);
}
