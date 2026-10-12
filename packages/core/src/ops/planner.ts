import type { AgentId, FileChange } from '../types.js';
import { displayPath, type Ctx } from '../context.js';
import type { Op } from '../fs/atomic.js';
import { unifiedDiff } from '../fs/diff.js';

/** 收集一次写操作的全部变更（纯内存，不落盘）。 */
export class Planner {
  readonly ops: Op[] = [];
  readonly warnings: string[] = [];

  constructor(
    readonly ctx: Ctx,
    /** relPath 的基准目录（项目根）；null 表示只用 `~/…` */
    readonly base: string | null,
  ) {}

  rel(p: string): string {
    return displayPath(this.ctx.home, this.base, p);
  }

  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  private push(op: Op): void {
    this.ops.push(op);
  }

  /** 普通文件：before → after（after 为 null 表示删除）。无变化时不记录。 */
  write(p: string, before: string | null, after: string | null, agent?: AgentId): void {
    if (before === after) return;
    const relPath = this.rel(p);
    const d = unifiedDiff(relPath, before, after);
    const change: FileChange = { path: p, relPath, type: 'file', before, after, ...d };
    if (agent) change.agent = agent;
    this.push({ change, action: after === null ? 'delete' : 'write' });
  }

  symlink(p: string, before: string | null, target: string, agent?: AgentId): void {
    if (before === target) return;
    const relPath = this.rel(p);
    const lines = [...(before === null ? [] : [`- ${relPath} -> ${before}`]), `+ ${relPath} -> ${target}`];
    const change: FileChange = {
      path: p,
      relPath,
      type: 'symlink',
      target,
      before,
      after: target,
      diff: lines.join('\n') + '\n',
      additions: 1,
      deletions: before === null ? 0 : 1,
    };
    if (agent) change.agent = agent;
    this.push({ change, action: 'symlink' });
  }

  unlink(p: string, before: string): void {
    const relPath = this.rel(p);
    this.push({
      change: { path: p, relPath, type: 'symlink', before, after: null, diff: `- ${relPath} -> ${before}\n`, additions: 0, deletions: 1 },
      action: 'unlink',
    });
  }

  mkdir(p: string): void {
    if (this.ops.some((o) => o.action === 'mkdir' && o.change.path === p)) return;
    const relPath = this.rel(p);
    this.push({
      change: { path: p, relPath, type: 'dir', before: null, after: null, diff: `mkdir ${relPath}/\n`, additions: 0, deletions: 0 },
      action: 'mkdir',
    });
  }

  rmdir(p: string): void {
    const relPath = this.rel(p);
    this.push({
      change: { path: p, relPath, type: 'dir', before: null, after: null, diff: `rmdir ${relPath}/\n`, additions: 0, deletions: 0 },
      action: 'rmdir',
    });
  }

  move(from: string, to: string): void {
    const relPath = this.rel(to);
    this.push({
      change: { path: to, relPath, type: 'dir', before: null, after: null, diff: `move ${this.rel(from)} -> ${relPath}\n`, additions: 0, deletions: 0 },
      action: 'move',
      from,
    });
  }

  /** 描述性条目（例如规划阶段已经完成的 git clone）。 */
  note(p: string, description: string): void {
    this.push({
      change: { path: p, relPath: this.rel(p), type: 'dir', before: null, after: null, diff: description + '\n', additions: 0, deletions: 0 },
      action: 'none',
    });
  }

  /** apply 阶段才执行的命令（例如 git worktree add）。 */
  exec(p: string, description: string, run: () => Promise<void>, undo?: () => Promise<void>): void {
    const op: Op = {
      change: { path: p, relPath: this.rel(p), type: 'dir', before: null, after: null, diff: description + '\n', additions: 0, deletions: 0 },
      action: 'exec',
      exec: run,
    };
    if (undo) op.undo = undo;
    this.push(op);
  }

  files(): FileChange[] {
    return this.ops.map((o) => o.change);
  }
}
