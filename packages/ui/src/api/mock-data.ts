/**
 * Seed data for the in-memory mock, mirroring design/prototypes/*.
 * Projects: web-app / agent-tool-manager / old-landing (missing dir).
 */
import type { ActivityEntry, AgentId, McpDef, PluginContents } from './types';

export const HOME = '/Users/dev';
export const ROOT = `${HOME}/.agent-tools`;
export const REGISTRY = `${ROOT}/mcp-registry`;

export interface SkillCat {
  name: string;
  repo: string;
  repoDir: string;
  path: string;
  commit: string;
  tokens: number | null;
  description?: string;
  /** Library "来源" override for local-only skills */
  sourceLabel?: string;
}

export interface McpCat {
  def: McpDef;
  origin: 'registry' | 'project';
  hash: string;
  tokens: number | null;
}

export interface PluginCat {
  localSource?: boolean;
  name: string;
  installed: boolean;
  version?: string;
  tokens: number | null;
  globallyEnabled: boolean;
  contents: PluginContents;
  note?: string;
}

export interface RepoCat {
  repo: string;
  dir: string;
  remote: string;
  head: string;
  branch?: string;
  dirty: boolean;
  ahead: number;
}

export type McpEntry = string | { name: string; agents?: AgentId[] };

export interface MockProject {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  initialized: boolean;
  agents: AgentId[];
  skills: Array<{ name: string; repo: string; rev?: string }>;
  mcp: McpEntry[];
  plugins: string[];
  /** skill names whose `.agents/skills/<name>` link points at a missing target */
  broken: string[];
  /** hand-written MCP entries atm must leave alone */
  handwritten: Partial<Record<AgentId, Record<string, unknown>>>;
}

export interface GlobalSkillCat {
  name: string;
  path: string;
  target: string;
  tokens: number;
}

export interface MockState {
  projects: MockProject[];
  skills: SkillCat[];
  mcp: McpCat[];
  plugins: PluginCat[];
  repos: RepoCat[];
  globalSkills: GlobalSkillCat[];
  env: string[];
  activity: ActivityEntry[];
  acknowledged: string[];
}

function todayAt(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export const IDS = {
  webApp: 'a1f3c9e20b7d',
  atm: '5c8e01d4a9b2',
  oldLanding: '9d27b6f0c3e1',
} as const;

export function seed(): MockState {
  return {
    env: ['FIGMA_API_KEY', 'LINEAR_TOKEN', 'GITHUB_TOKEN'],
    skills: [
      {
        name: 'baoyu-comic',
        repo: 'jimliu/baoyu-skills',
        repoDir: `${ROOT}/baoyu-skills`,
        path: 'skills/baoyu-comic',
        commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        tokens: 96,
        description: '把一段故事或概念画成多格漫画',
      },
      {
        name: 'baoyu-cover',
        repo: 'jimliu/baoyu-skills',
        repoDir: `${ROOT}/baoyu-skills`,
        path: 'skills/baoyu-cover',
        commit: 'c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7',
        tokens: 88,
        description: '为文章生成封面图',
      },
      {
        name: 'agent-tools',
        repo: 'wuwenjun/agent-tool-manager',
        repoDir: `${ROOT}/atm`,
        path: 'skill/agent-tools',
        commit: 'e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3',
        tokens: null,
        description: 'atm 入口 Skill · 全局安装',
        sourceLabel: '~/.agent-tools/atm/skill',
      },
    ],
    mcp: [
      {
        def: {
          name: 'figma',
          description: 'Figma 设计文件读取',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'figma-developer-mcp', '--stdio'],
          env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' },
        },
        origin: 'registry',
        hash: 'sha256:9f3e7a10c2b84d5e96f1a3b7c0d2e4f6a8b1c3d5e7f9a0b2c4d6e8f0a1b3c5d7',
        tokens: 4200,
      },
      {
        def: { name: 'playwright', transport: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
        origin: 'registry',
        hash: 'sha256:41ac92d0e7f3b6a5c4d1e8f2a9b0c3d6e5f4a7b8c1d0e3f2a5b4c7d6e9f8a1b0',
        tokens: 1400,
      },
      {
        def: {
          name: 'linear',
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
        },
        origin: 'registry',
        hash: 'sha256:7be1d4c09a3f5e2b8c6d0a1f4e7b3c9d2a5f8e1b4c7d0a3f6e9b2c5d8a1f4e7b',
        tokens: null,
      },
    ],
    plugins: [
      {
        name: 'security-guidance@claude-plugins-official',
        installed: true,
        version: '1.0.2',
        tokens: 300,
        globallyEnabled: false,
        contents: {
          skills: [{ name: 'security-review', description: '提交前检查常见安全问题', contextTokens: 300 }],
          mcp: [],
          commands: ['security-review'],
          agents: [],
          hooks: true,
        },
      },
      {
        name: 'figma@claude-plugins-official',
        installed: true,
        version: '0.4.0',
        tokens: null,
        globallyEnabled: true,
        note: '自带 MCP',
        contents: { skills: [], mcp: ['figma'], commands: [], agents: [], hooks: false },
      },
    ],
    repos: [
      {
        repo: 'jimliu/baoyu-skills',
        dir: `${ROOT}/baoyu-skills`,
        remote: 'https://github.com/jimliu/baoyu-skills.git',
        head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        branch: 'main',
        dirty: true,
        ahead: 0,
      },
      {
        repo: 'wuwenjun/agent-tool-manager',
        dir: `${ROOT}/atm`,
        remote: 'https://github.com/wuwenjun/agent-tool-manager.git',
        head: 'e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3',
        branch: 'main',
        dirty: false,
        ahead: 0,
      },
    ],
    globalSkills: [
      {
        name: 'agent-tools',
        path: `${HOME}/.claude/skills/agent-tools`,
        target: `${ROOT}/atm/skill/agent-tools`,
        tokens: 120,
      },
    ],
    projects: [
      {
        id: IDS.webApp,
        name: 'web-app',
        path: `${HOME}/work/web-app`,
        exists: true,
        initialized: true,
        agents: ['claude-code', 'cursor'],
        skills: [
          { name: 'baoyu-comic', repo: 'jimliu/baoyu-skills' },
          { name: 'baoyu-cover', repo: 'jimliu/baoyu-skills', rev: 'v1.2.0' },
        ],
        mcp: ['figma', { name: 'playwright', agents: ['claude-code'] }],
        plugins: ['security-guidance@claude-plugins-official'],
        broken: [],
        handwritten: {
          'claude-code': {
            github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
          },
        },
      },
      {
        id: IDS.atm,
        name: 'agent-tool-manager',
        path: `${HOME}/personal/workspace/agent-tool-manager`,
        exists: true,
        initialized: true,
        agents: ['claude-code'],
        skills: [{ name: 'baoyu-comic', repo: 'jimliu/baoyu-skills' }],
        mcp: ['playwright'],
        plugins: [],
        broken: ['baoyu-comic'],
        handwritten: {},
      },
      {
        id: IDS.oldLanding,
        name: 'old-landing',
        path: `${HOME}/work/old-landing`,
        exists: false,
        initialized: true,
        agents: ['claude-code'],
        skills: [],
        mcp: [],
        plugins: [],
        broken: [],
        handwritten: {},
      },
    ],
    activity: [
      {
        at: todayAt(10, 42),
        level: 'info',
        kind: 'mcp',
        projectId: IDS.webApp,
        projectName: 'web-app',
        message: '通过 CLI 添加了 `playwright`（仅 Claude Code）',
      },
      {
        at: todayAt(10, 15),
        level: 'info',
        kind: 'skill',
        projectName: '~/.agent-tools',
        message: '`jimliu/baoyu-skills` pull --ff-only 完成，lock 已更新',
      },
      {
        at: todayAt(9, 58),
        level: 'error',
        projectId: IDS.atm,
        projectName: 'agent-tool-manager',
        message: '检测到断链 .agents/skills/baoyu-comic',
      },
    ],
    acknowledged: [],
  };
}
