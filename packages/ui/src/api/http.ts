import { ApiError, type ApiClient, type ConnectionStatus, type DryRunOpt, type McpDefScope, type TaskInfo, type TaskRef, type WriteOpt } from './client';
import type {
  ActivityEntry,
  AddSpec,
  AgentId,
  AtmErrorJson,
  AtmEvent,
  BatchOp,
  BatchResult,
  DoctorReport,
  FileChange,
  GlobalConfig,
  GlobalReport,
  LibraryItem,
  McpDef,
  MigrateSpec,
  ProjectDetail,
  ProjectSummary,
  RepoStatus,
  ToolKind,
  WriteResult,
} from './types';

type Query = Record<string, string | boolean | undefined>;

function qs(q: Query = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === false || v === '') continue;
    p.set(k, v === true ? '1' : v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

/** Talks to `@atm/server` on the same origin. */
export class HttpApiClient implements ApiClient {
  readonly kind = 'http' as const;

  constructor(
    private readonly token: string | null,
    private readonly base = '',
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, q?: Query): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.base}/api${path}${qs(q)}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError('NETWORK', `无法连接 atm server：${(e as Error).message}`);
    }
    const text = await res.text();
    const data: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) {
      if (res.status === 401) {
        throw new ApiError('UNAUTHORIZED', '未授权：请使用 `atm ui` 打印的带 token 链接重新打开', {
          status: 401,
          nextCommand: 'atm ui',
        });
      }
      const err = (data as AtmErrorJson | undefined)?.error;
      if (err) {
        throw new ApiError(err.code, err.message, {
          status: res.status,
          ...(err.nextCommand ? { nextCommand: err.nextCommand } : {}),
          ...(err.candidates ? { candidates: err.candidates } : {}),
        });
      }
      throw new ApiError('HTTP', `HTTP ${res.status}`, { status: res.status });
    }
    return data as T;
  }

  getConfig() {
    return this.req<GlobalConfig>('GET', '/config');
  }
  patchConfig(patch: Partial<GlobalConfig>) {
    return this.req<GlobalConfig>('PATCH', '/config', patch);
  }

  getProjects() {
    return this.req<ProjectSummary[]>('GET', '/projects');
  }
  registerProject(path: string) {
    return this.req<ProjectSummary>('POST', '/projects', { path });
  }
  unregisterProject(id: string) {
    return this.req<{ ok: true }>('DELETE', `/projects/${enc(id)}`);
  }
  patchProject(id: string, patch: { path?: string; agents?: AgentId[] }, opts: DryRunOpt = {}) {
    return this.req<ProjectDetail | WriteResult>('PATCH', `/projects/${enc(id)}`, patch, { dryRun: opts.dryRun });
  }
  getProject(id: string) {
    return this.req<ProjectDetail>('GET', `/projects/${enc(id)}`);
  }
  initProject(id: string, opts: WriteOpt = {}) {
    return this.req<WriteResult>('POST', `/projects/${enc(id)}/init`, undefined, { dryRun: opts.dryRun, adopt: opts.adopt, force: opts.force });
  }
  addTool(id: string, spec: AddSpec, opts: WriteOpt = {}) {
    return this.req<WriteResult>('POST', `/projects/${enc(id)}/tools`, spec, { dryRun: opts.dryRun, adopt: opts.adopt, force: opts.force });
  }
  removeTool(id: string, kind: ToolKind, name: string, opts: DryRunOpt = {}) {
    return this.req<WriteResult>('DELETE', `/projects/${enc(id)}/tools/${kind}/${enc(name)}`, undefined, {
      dryRun: opts.dryRun,
    });
  }
  install(id: string, opts: WriteOpt & { strict?: boolean } = {}) {
    return this.req<WriteResult>('POST', `/projects/${enc(id)}/install`, undefined, {
      dryRun: opts.dryRun,
      adopt: opts.adopt,
      force: opts.force,
      strict: opts.strict,
    });
  }
  getGenerated(id: string) {
    return this.req<FileChange[]>('GET', `/projects/${enc(id)}/generated`);
  }
  measure(id: string, mcpName: string) {
    return this.req<TaskRef>('POST', `/projects/${enc(id)}/measure/${enc(mcpName)}`);
  }
  pin(id: string, skill: string, rev: string, opts: DryRunOpt = {}) {
    return this.req<WriteResult>('POST', `/projects/${enc(id)}/pin`, { skill, rev }, { dryRun: opts.dryRun });
  }

  getDoctor(id?: string, opts?: { measure?: false }): Promise<DoctorReport>;
  getDoctor(id: string | undefined, opts: { measure: true }): Promise<TaskRef>;
  getDoctor(id?: string, opts: { measure?: boolean } = {}): Promise<DoctorReport | TaskRef> {
    const path = id ? `/projects/${enc(id)}/doctor` : '/doctor';
    return this.req<DoctorReport | TaskRef>('GET', path, undefined, { measure: opts.measure });
  }
  fix(issueIds: string[], opts: DryRunOpt = {}) {
    return this.req<WriteResult>('POST', '/doctor/fix', { issueIds }, { dryRun: opts.dryRun });
  }

  getLibrary(q?: string) {
    return this.req<LibraryItem[]>('GET', '/library', undefined, { q });
  }
  getRepos() {
    return this.req<RepoStatus[]>('GET', '/repos');
  }
  cloneRepo(repo: string) {
    return this.req<TaskRef>('POST', '/repos', { repo });
  }
  sync(repos?: string[]) {
    return this.req<TaskRef>('POST', '/sync', repos ? { repos } : {});
  }
  saveMcpDef(def: McpDef, scope: McpDefScope) {
    return this.req<{ path: string }>('POST', '/mcp-defs', { def, scope });
  }

  batch(ops: BatchOp[], opts: WriteOpt = {}) {
    return this.req<BatchResult>('POST', '/batch', { ops }, { dryRun: opts.dryRun, adopt: opts.adopt, force: opts.force });
  }
  getGlobal() {
    return this.req<GlobalReport>('GET', '/global');
  }
  migrate(spec: MigrateSpec, opts: DryRunOpt = {}) {
    return this.req<WriteResult>('POST', '/global/migrate', spec, { dryRun: opts.dryRun });
  }

  getActivity() {
    return this.req<ActivityEntry[]>('GET', '/activity');
  }
  getTask(id: string) {
    return this.req<TaskInfo>('GET', `/tasks/${enc(id)}`);
  }
  async cancelTask(id: string) {
    await this.req<unknown>('DELETE', `/tasks/${enc(id)}`);
  }

  subscribe(onEvent: (e: AtmEvent) => void, onStatus?: (s: ConnectionStatus) => void): () => void {
    if (typeof EventSource === 'undefined') {
      onStatus?.('closed');
      return () => {};
    }
    onStatus?.('connecting');
    const es = new EventSource(`${this.base}/api/events${qs({ token: this.token ?? undefined })}`);
    es.onopen = () => onStatus?.('open');
    // EventSource reconnects by itself; report the gap.
    es.onerror = () => onStatus?.(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
    es.onmessage = (msg: MessageEvent<string>) => {
      const e = safeJson(msg.data) as AtmEvent | undefined;
      if (e && typeof e === 'object' && 'type' in e) onEvent(e);
    };
    return () => {
      es.close();
      onStatus?.('closed');
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
