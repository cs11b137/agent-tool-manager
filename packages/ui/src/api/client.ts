import type {
  ActivityEntry,
  AddSpec,
  AgentId,
  AtmErrorCode,
  AtmEvent,
  BatchOp,
  BatchResult,
  DoctorReport,
  FileChange,
  GlobalConfig,
  SharedDirectoryInput,
  SharedRepositoryInput,
  SharedRepositoryStatus,
  CreateSharedToolInput,
  GlobalReport,
  LibraryItem,
  LibraryOptions,
  McpDef,
  MigrateSpec,
  ProjectDetail,
  ProjectSummary,
  RepoStatus,
  ToolKind,
  WriteResult,
} from './types';

export interface TaskRef {
  taskId: string;
}

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskInfo {
  id: string;
  title: string;
  status: TaskStatus;
  progress?: { message: string; percent?: number };
  result?: unknown;
  error?: string;
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface DryRunOpt {
  dryRun?: boolean;
}

/** `--adopt` / `--force` of the CLI: take over hand-written entries / overwrite conflicting files. */
export interface WriteOpt extends DryRunOpt {
  adopt?: boolean;
  force?: boolean;
}

export type McpDefScope = 'registry' | { projectId: string };

/**
 * One method per endpoint in docs/implementation-contract.md §4.
 * Implemented by `HttpApiClient` (real server) and `MockApiClient` (in-memory demo data).
 */
export interface ApiClient {
  readonly kind: 'http' | 'mock';

  selectDirectory(initialPath?: string): Promise<{ path: string | null }>;

  // config
  getConfig(): Promise<GlobalConfig>;
  patchConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig>;
  initSharedDirectory(input: SharedDirectoryInput): Promise<GlobalConfig>;

  getSharedRepository(): Promise<SharedRepositoryStatus>;
  initSharedRepository(input: SharedRepositoryInput): Promise<GlobalConfig>;
  setSharedRemote(remote: string): Promise<SharedRepositoryStatus>;
  commitSharedRepository(message: string): Promise<SharedRepositoryStatus>;
  pushSharedRepository(): Promise<SharedRepositoryStatus>;
  createSharedTool(input: CreateSharedToolInput): Promise<{ path: string }>;

  // projects
  getProjects(): Promise<ProjectSummary[]>;
  registerProject(path: string): Promise<ProjectSummary>;
  unregisterProject(id: string): Promise<{ ok: true }>;
  patchProject(id: string, patch: { path?: string; agents?: AgentId[] }, opts?: DryRunOpt): Promise<ProjectDetail | WriteResult>;
  getProject(id: string): Promise<ProjectDetail>;
  initProject(id: string, opts?: WriteOpt): Promise<WriteResult>;
  addTool(id: string, spec: AddSpec, opts?: WriteOpt): Promise<WriteResult>;
  removeTool(id: string, kind: ToolKind, name: string, opts?: DryRunOpt): Promise<WriteResult>;
  install(id: string, opts?: WriteOpt & { strict?: boolean }): Promise<WriteResult>;
  getGenerated(id: string): Promise<FileChange[]>;
  measure(id: string, mcpName: string): Promise<TaskRef>;
  pin(id: string, skill: string, rev: string, opts?: DryRunOpt): Promise<WriteResult>;

  // doctor
  getDoctor(id?: string, opts?: { measure?: false }): Promise<DoctorReport>;
  getDoctor(id: string | undefined, opts: { measure: true }): Promise<TaskRef>;
  fix(issueIds: string[], opts?: DryRunOpt): Promise<WriteResult>;

  // library & repos
  getLibrary(q?: string, opts?: LibraryOptions): Promise<LibraryItem[]>;
  getRepos(): Promise<RepoStatus[]>;
  cloneRepo(repo: string): Promise<TaskRef>;
  sync(repos?: string[]): Promise<TaskRef>;
  saveMcpDef(def: McpDef, scope: McpDefScope): Promise<{ path: string }>;

  // matrix / global
  batch(ops: BatchOp[], opts?: WriteOpt): Promise<BatchResult>;
  getGlobal(): Promise<GlobalReport>;
  migrate(spec: MigrateSpec, opts?: WriteOpt): Promise<WriteResult>;

  // activity & tasks
  getActivity(): Promise<ActivityEntry[]>;
  getTask(id: string): Promise<TaskInfo>;
  cancelTask(id: string): Promise<void>;

  /** SSE stream. Returns an unsubscribe function. */
  subscribe(onEvent: (e: AtmEvent) => void, onStatus?: (s: ConnectionStatus) => void): () => void;
}

/** Error thrown by both clients; mirrors `AtmErrorJson`. */
export class ApiError extends Error {
  readonly code: AtmErrorCode | 'UNAUTHORIZED' | 'NETWORK' | 'HTTP';
  readonly status: number;
  readonly nextCommand?: string;
  readonly candidates?: string[];

  constructor(
    code: ApiError['code'],
    message: string,
    opts: { status?: number; nextCommand?: string; candidates?: string[] } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = opts.status ?? 0;
    if (opts.nextCommand !== undefined) this.nextCommand = opts.nextCommand;
    if (opts.candidates !== undefined) this.candidates = opts.candidates;
  }
}

export function isTaskRef(v: unknown): v is TaskRef {
  return typeof v === 'object' && v !== null && 'taskId' in v && typeof (v as TaskRef).taskId === 'string';
}

export function isWriteResult(v: unknown): v is WriteResult {
  return typeof v === 'object' && v !== null && 'files' in v && Array.isArray((v as WriteResult).files);
}
