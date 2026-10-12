/**
 * @atm/core 公共类型契约。
 *
 * 这是 core / cli / server / ui 四个包共享的唯一类型来源。
 * 这个文件必须保持「纯类型」：不 import 任何 Node 模块，浏览器端（ui）会 `import type` 它。
 *
 * 对应技术方案 docs/tech-design.md §5（数据模型）、§7（命令）、§9.3（本地 API）。
 */

// ───────────────────────────── 基础枚举 ─────────────────────────────

export type AgentId = 'claude-code' | 'cursor' | 'codex';
export const ALL_AGENTS: readonly AgentId[] = ['claude-code', 'cursor', 'codex'];

/** 工具类型。文档中的 kind 名称（skill / capability / bundle）在代码与 API 中统一用下面三个短名。 */
export type ToolKind = 'skill' | 'mcp' | 'plugin';

export type DoctorLevel = 'error' | 'warn' | 'info';

// ───────────────────────────── 磁盘文件（§5） ─────────────────────────────

/** `.agents/tools.json` */
export interface ToolsManifest {
  $schema?: string;
  agents: AgentId[];
  skills: SkillRef[];
  mcp: Array<string | McpRef>;
  plugins: string[];
}

export interface SkillRef {
  /** `owner/repo` 或完整 git URL */
  repo: string;
  /** SKILL.md frontmatter 的 name */
  name: string;
  /** 分支 / tag / sha，可选 */
  rev?: string;
}

export interface McpRef {
  name: string;
  /** 覆盖清单级 agents */
  agents?: AgentId[];
}

/** `.agents/tools.lock.json` */
export interface LockFile {
  version: 1;
  skills: Record<string, LockedSkill>;
  mcp: Record<string, LockedMcp>;
  managed: Partial<Record<AgentId, ManagedEntries>>;
}

export interface LockedSkill {
  repo: string;
  /** 相对于仓库根目录的路径 */
  path: string;
  commit: string;
  rev?: string;
  contextTokens: number;
  /**
   * `atm pin` 后指向的 worktree 目录，相对共享仓库根目录 `<root>`（如 `.worktrees/<repo>@<rev>`）。
   * lock 会被提交，因此不存机器相关的绝对路径；解析到 `<root>` 之外的值会被拒绝。
   */
  worktree?: string;
}

export interface LockedMcp {
  /** `sha256:…`，对定义 JSON 的规范化哈希 */
  hash: string;
  /** `doctor --measure` 的结果；未测量为 undefined */
  contextTokens?: number;
}

export interface ManagedEntries {
  mcp: string[];
  plugins: string[];
}

/** registry 中的 `<name>.json` 或项目内 `.agents/mcp/<name>.json` */
export type McpDef = McpStdioDef | McpHttpDef;

export interface McpDefBase {
  name: string;
  description?: string;
}

export interface McpStdioDef extends McpDefBase {
  transport: 'stdio';
  command: string;
  args?: string[];
  /** 值必须是 `${VAR}` 形式 */
  env?: Record<string, string>;
}

export interface McpHttpDef extends McpDefBase {
  transport: 'http';
  url: string;
  /** 值必须是 `${VAR}` 形式（允许 `Bearer ${VAR}` 这种带前缀的写法） */
  headers?: Record<string, string>;
}

/** `~/.config/atm/config.json` */
export interface GlobalConfig {
  /** 共享仓库根目录，默认 `~/GitHub` */
  root: string;
  /** MCP registry 目录，默认 `<root>/mcp-registry` */
  mcpRegistry: string;
  defaultAgents: AgentId[];
  /** 已注册项目的绝对路径（存储时允许 `~` 前缀） */
  projects: string[];
}

// ───────────────────────────── 查询结果（list / projects / library） ─────────────────────────────

export interface ContextBreakdown {
  skill: number;
  mcp: number;
  plugin: number;
  total: number;
  /** 未测量（显示为 `?`）的工具数量 */
  unmeasured: number;
}

export interface DoctorCounts {
  error: number;
  warn: number;
  info: number;
}

/** 总览页用的项目摘要 */
export interface ProjectSummary {
  /** 稳定 id：绝对路径的 sha1 前 12 位 */
  id: string;
  /** 目录名 */
  name: string;
  /** 绝对路径 */
  path: string;
  /** 目录是否存在（注册表里有但目录没了 → false，GUI 标灰） */
  exists: boolean;
  /** 是否已 `atm init`（存在 .agents/tools.json） */
  initialized: boolean;
  agents: AgentId[];
  counts: { skills: number; mcp: number; plugins: number };
  context: ContextBreakdown;
  doctor: DoctorCounts;
}

/** 项目详情页 / `atm list --json` */
export interface ProjectDetail extends ProjectSummary {
  manifestPath: string;
  tools: ToolEntry[];
  issues: DoctorIssue[];
}

export interface ToolEntry {
  kind: ToolKind;
  name: string;
  /** 来源的简短描述：`jimliu/baoyu-skills`、`registry`、`project`、`@claude-plugins-official` */
  source: string;
  /** 在哪些 Agent 中生效 */
  agents: AgentId[];
  /** 常驻上下文估算；null 表示未测量 */
  contextTokens: number | null;
  /** 是否在清单中启用（GUI 开关）。v1 中清单里的工具总是 enabled=true，预留给「停用但保留」 */
  enabled: boolean;
  skill?: ToolSkillInfo;
  mcp?: ToolMcpInfo;
  plugin?: ToolPluginInfo;
}

export interface ToolSkillInfo {
  repo: string;
  /** 仓库内相对路径 */
  path: string;
  commit: string;
  rev?: string;
  description?: string;
  /** 软链目标（绝对路径） */
  target: string;
  /** 软链是否存在 */
  linked: boolean;
  /** 软链存在但目标不存在 */
  broken: boolean;
}

export interface ToolMcpInfo {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /** 定义来自全局 registry 还是项目内 `.agents/mcp/` */
  origin: 'registry' | 'project';
  hash: string;
  description?: string;
  /** 引用的环境变量及其是否已在当前环境中设置。任何接口都不返回值。 */
  envVars: EnvVarStatus[];
}

export interface EnvVarStatus {
  name: string;
  set: boolean;
}

export interface ToolPluginInfo {
  /** `security-guidance@claude-plugins-official` 中的 marketplace 部分 */
  marketplace: string;
  installed: boolean;
  version?: string;
  installPath?: string;
  /** 是否在 `~/.claude/settings.json` 中全局启用 */
  globallyEnabled: boolean;
  /** 插件自带的内容 */
  contents?: PluginContents;
}

export interface PluginContents {
  skills: Array<{ name: string; description?: string; contextTokens: number }>;
  mcp: string[];
  commands: string[];
  agents: string[];
  hooks: boolean;
}

/** 工具库页：`~/GitHub`、registry、已安装插件中所有可发现的工具 */
export interface LibraryItem {
  kind: ToolKind;
  name: string;
  description?: string;
  /** 同 ToolEntry.source */
  source: string;
  /** 补充说明：skill 的仓库内路径 / mcp 的 transport / plugin 的 marketplace */
  detail?: string;
  contextTokens: number | null;
  /** 使用它的项目 id 列表 */
  usedBy: string[];
  /** 全局安装 / 全局启用 */
  global: boolean;
  skill?: { repo: string; repoDir: string; path: string; commit: string };
  mcp?: { transport: 'stdio' | 'http'; origin: 'registry' | 'project'; envVars: EnvVarStatus[] };
  plugin?: { marketplace: string; installed: boolean; version?: string; globallyEnabled: boolean };
}

export interface RepoStatus {
  /** `owner/repo` */
  repo: string;
  dir: string;
  remote: string;
  head: string;
  branch?: string;
  dirty: boolean;
  /** 本地领先远端的提交数 */
  ahead: number;
  usedBy: string[];
}

// ───────────────────────────── doctor（§7） ─────────────────────────────

export type DoctorCode =
  | 'broken-link' // error：软链目标不存在
  | 'missing-link' // error：清单里有但软链不存在（未 install）
  | 'plaintext-secret' // error：配置中出现明文密钥
  | 'plugin-not-installed' // error：清单引用了未安装的插件
  | 'skill-shadowed' // warn：项目 Skill 与全局 Skill 同名
  | 'mcp-dup-plugin' // warn：清单 MCP 与已启用插件自带的 MCP 同名
  | 'rev-mismatch' // warn：共享仓库 HEAD 与清单 rev / lock commit 不一致
  | 'repo-dirty' // info：共享仓库有未提交或未推送的改动
  | 'plugin-global-only' // info：全局启用、但只有本项目在用的插件
  | 'context-total' // info：本项目工具总上下文占用
  | 'project-missing' // error：注册表中的项目目录不存在
  | 'config-unparseable' // error：Agent 配置文件（.mcp.json 等）无法解析，未能做密钥扫描
  | 'skill-dir-conflict'; // error：`.agents/skills/<name>` 或 `.claude/skills` 是实体目录/文件，不能自动修复

export interface DoctorIssue {
  /** 稳定 id：`${code}:${projectId}:${kind}:${name}` 的组合，供「一键修复」引用 */
  id: string;
  level: DoctorLevel;
  code: DoctorCode;
  projectId?: string;
  projectName?: string;
  kind?: ToolKind;
  name?: string;
  /** 一句话标题 */
  title: string;
  /** 详细说明 */
  detail?: string;
  /** 下一步该执行的命令 */
  nextCommand?: string;
  /** 能否被 `fix` 安全修复（只有缺失或断掉的软链：missing-link / broken-link 的子集） */
  fixable: boolean;
}

export interface DoctorReport {
  /** ISO 时间 */
  checkedAt: string;
  /** 是否执行了 --measure */
  measured: boolean;
  counts: DoctorCounts;
  issues: DoctorIssue[];
  /** 本次覆盖的项目 */
  projects: Array<{ id: string; name: string; context: ContextBreakdown }>;
}

// ───────────────────────────── 写操作与 dryRun（§9.3） ─────────────────────────────

export interface FileChange {
  /** 绝对路径 */
  path: string;
  /** 相对项目根（或 `~/…`）的展示路径 */
  relPath: string;
  /** 文件类型：普通文件 / 软链 / 目录 */
  type: 'file' | 'symlink' | 'dir';
  /** 对软链：目标路径 */
  target?: string;
  /** 写入前内容；文件不存在为 null */
  before: string | null;
  /** 写入后内容；删除为 null */
  after: string | null;
  /** unified diff 文本（软链 / 目录为简短描述） */
  diff: string;
  additions: number;
  deletions: number;
  /** 是否由哪个 Agent 负责（用于 diff 面板右上角的「Claude Code · 提交」） */
  agent?: AgentId;
}

export interface WriteResult {
  /** dryRun 时为 false */
  applied: boolean;
  files: FileChange[];
  warnings: string[];
  /** 等价的 CLI 命令，GUI 底部展示 */
  command?: string;
  /** 操作后本项目的上下文估算（dryRun 也会算） */
  contextAfter?: ContextBreakdown;
}

export type AddSpec =
  | { kind: 'skill'; repo: string; name: string; rev?: string }
  | { kind: 'mcp'; name: string; agents?: AgentId[] }
  | { kind: 'plugin'; name: string };

export interface WriteOptions {
  dryRun?: boolean;
  /** 遇到手写条目时接管为 atm 管理 */
  adopt?: boolean;
  /** 覆盖冲突（init 迁移 / 占用的克隆目录） */
  force?: boolean;
}

export interface InstallOptions extends WriteOptions {
  /** lock.commit 与仓库 HEAD 不一致时报错而不是警告 */
  strict?: boolean;
}

export interface BatchOp {
  projectId: string;
  action: 'add' | 'remove';
  spec: AddSpec | { kind: ToolKind; name: string };
}

export interface BatchResult {
  applied: boolean;
  results: Array<{ projectId: string; result: WriteResult | { error: string } }>;
}

export interface SyncResult {
  repos: Array<{
    repo: string;
    dir: string;
    status: 'updated' | 'up-to-date' | 'skipped-dirty' | 'skipped-diverged' | 'cloned' | 'failed';
    from?: string;
    to?: string;
    message?: string;
  }>;
  /** 因 commit 变化而更新了 lock 的项目 */
  updatedProjects: string[];
}

export interface MeasureResult {
  name: string;
  contextTokens: number;
  toolCount: number;
}

export interface SearchResult {
  items: LibraryItem[];
}

// ───────────────────────────── 全局页（P5） ─────────────────────────────

export interface GlobalReport {
  /** `~/.claude/skills` 下的全局 Skill */
  skills: Array<{
    name: string;
    path: string;
    /** 软链目标 */
    target?: string;
    contextTokens: number;
    /** 哪些项目也引用了同名 Skill */
    shadowedBy: string[];
  }>;
  /** `~/.claude/settings.json` 全局启用的插件 */
  plugins: Array<{
    name: string;
    installed: boolean;
    contextTokens: number | null;
    /** 已在哪些项目的清单中 */
    usedBy: string[];
  }>;
}

export interface MigrateSpec {
  kind: 'skill' | 'plugin';
  name: string;
  projectIds: string[];
  /** 迁移完成后是否从全局移除 */
  removeGlobal: boolean;
}

// ───────────────────────────── 事件（SSE） ─────────────────────────────

export interface ActivityEntry {
  /** ISO 时间 */
  at: string;
  level: 'info' | 'warn' | 'error';
  kind?: ToolKind;
  projectId?: string;
  projectName?: string;
  /** 一句话 */
  message: string;
}

export type AtmEvent =
  | { type: 'project.changed'; projectId: string; reason: 'manifest' | 'agent-config' | 'registry' }
  | { type: 'library.changed' }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'task.started'; taskId: string; title: string }
  | { type: 'task.progress'; taskId: string; message: string; percent?: number }
  | { type: 'task.done'; taskId: string; result?: unknown }
  | { type: 'task.failed'; taskId: string; error: string }
  | { type: 'task.cancelled'; taskId: string };

// ───────────────────────────── 错误 ─────────────────────────────

export type AtmErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_EXISTS'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'CONFLICT' // 手写条目 / 实体目录 / 克隆目录被占用
  | 'INVALID_MANIFEST'
  | 'INVALID_MCP_DEF'
  | 'PLUGIN_NOT_INSTALLED'
  | 'LOCKED' // 另一个 atm 进程正在写
  | 'GIT_FAILED'
  | 'REV_MISMATCH'
  | 'UNSUPPORTED';

/** 序列化后的错误（`--json` 输出与 HTTP 响应体） */
export interface AtmErrorJson {
  error: {
    code: AtmErrorCode;
    message: string;
    /** 下一步该执行的命令 */
    nextCommand?: string;
    /** 补充信息，比如候选名字列表 */
    candidates?: string[];
  };
}

// ───────────────────────────── core 公共接口（追加） ─────────────────────────────

/** `saveMcpDef` 的保存位置：全局 registry，或某个项目的 `.agents/mcp/`（projectDir 可以是项目 id 或路径）。 */
export type McpDefScope = 'registry' | { projectDir: string };

/**
 * `createAtm()` 返回的对象（契约 §2）。所有接收 `dir` 的方法也接受项目 id。
 * 除 `projectId` / `watch` 外全部返回 Promise。
 */
export interface Atm {
  config(): Promise<GlobalConfig>;
  saveConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig>;
  projects(): Promise<ProjectSummary[]>;
  registerProject(dir: string): Promise<ProjectSummary>;
  unregisterProject(idOrDir: string): Promise<void>;
  relocateProject(id: string, newDir: string): Promise<ProjectSummary>;
  resolveProject(idOrDir: string): Promise<string>;
  /** `sha1(absolutePath).slice(0, 12)` */
  projectId(path: string): string;

  init(dir: string, opts?: WriteOptions): Promise<WriteResult>;
  add(dir: string, spec: AddSpec, opts?: WriteOptions): Promise<WriteResult>;
  remove(dir: string, name: string, opts?: WriteOptions & { kind?: ToolKind }): Promise<WriteResult>;
  install(dir: string, opts?: InstallOptions): Promise<WriteResult>;
  /** 修改清单的 agents 并按 install 流程重新渲染（server `PATCH /api/projects/:id` 用） */
  setAgents(dir: string, agents: AgentId[], opts?: WriteOptions): Promise<WriteResult>;
  sync(repos?: string[], opts?: WriteOptions): Promise<SyncResult>;
  list(dir: string): Promise<ProjectDetail>;
  doctor(target: string | 'all', opts?: { measure?: boolean }): Promise<DoctorReport>;
  fix(issueIds: string[], opts?: WriteOptions): Promise<WriteResult>;
  measure(dir: string, mcpName: string): Promise<MeasureResult>;
  pin(dir: string, skillName: string, rev: string, opts?: WriteOptions): Promise<WriteResult>;

  library(): Promise<LibraryItem[]>;
  search(query: string): Promise<SearchResult>;
  repos(): Promise<RepoStatus[]>;
  cloneRepo(repo: string): Promise<RepoStatus>;
  saveMcpDef(def: McpDef, scope: McpDefScope): Promise<{ path: string }>;
  global(): Promise<GlobalReport>;
  migrate(spec: MigrateSpec, opts?: WriteOptions): Promise<WriteResult>;
  batch(ops: BatchOp[], opts?: WriteOptions): Promise<BatchResult>;
  diffGenerated(dir: string): Promise<FileChange[]>;
  /** 监听项目（空数组 = 全部已注册项目）与 registry；同步返回停止函数（`await` 它也可以） */
  watch(dirs: string[], cb: (e: AtmEvent) => void): () => void;
}
