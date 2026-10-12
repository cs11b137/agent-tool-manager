import { randomBytes } from 'node:crypto';
import type { AtmEvent } from '@atm/core';

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskInfo {
  id: string;
  title: string;
  status: TaskStatus;
  progress?: { message: string; percent?: number };
  result?: unknown;
  error?: string;
}

export interface TaskContext {
  signal: AbortSignal;
  progress(message: string, percent?: number): void;
}

interface TaskEntry {
  info: TaskInfo;
  controller: AbortController;
}

/** Tiny in-process registry for long-running operations (clone, sync, measure). */
export class TaskManager {
  private readonly tasks = new Map<string, TaskEntry>();

  constructor(
    private readonly emit: (e: AtmEvent) => void,
    private readonly keepFinished = 100,
  ) {}

  start<T>(title: string, run: (ctx: TaskContext) => Promise<T>): string {
    const id = randomBytes(6).toString('hex');
    const controller = new AbortController();
    const info: TaskInfo = { id, title, status: 'running' };
    this.tasks.set(id, { info, controller });
    this.emit({ type: 'task.started', taskId: id, title });

    const ctx: TaskContext = {
      signal: controller.signal,
      progress: (message, percent) => {
        if (info.status !== 'running') return;
        info.progress = percent === undefined ? { message } : { message, percent };
        this.emit(percent === undefined ? { type: 'task.progress', taskId: id, message } : { type: 'task.progress', taskId: id, message, percent });
      },
    };

    // Defer so that callers get the id back (and can subscribe) before anything happens.
    setImmediate(() => {
      if (info.status !== 'running') return;
      Promise.resolve()
        .then(() => run(ctx))
        .then(
          (result) => {
            if (info.status !== 'running') return;
            info.status = 'done';
            info.result = result;
            this.emit({ type: 'task.done', taskId: id, result });
          },
          (err: unknown) => {
            if (info.status !== 'running') return;
            info.status = 'failed';
            info.error = err instanceof Error ? err.message : String(err);
            this.emit({ type: 'task.failed', taskId: id, error: info.error });
          },
        )
        .finally(() => this.prune());
    });
    return id;
  }

  get(id: string): TaskInfo | undefined {
    const e = this.tasks.get(id);
    return e ? { ...e.info } : undefined;
  }

  /** Aborts a running task. Returns the task (undefined when unknown). Finished tasks are left as-is. */
  cancel(id: string): TaskInfo | undefined {
    const e = this.tasks.get(id);
    if (!e) return undefined;
    if (e.info.status === 'running') {
      e.info.status = 'cancelled';
      e.controller.abort(new Error('cancelled'));
      this.emit({ type: 'task.cancelled', taskId: id });
    }
    return { ...e.info };
  }

  cancelAll(): void {
    for (const id of this.tasks.keys()) this.cancel(id);
  }

  private prune(): void {
    const finished = [...this.tasks.values()].filter((t) => t.info.status !== 'running');
    for (const t of finished.slice(0, Math.max(0, finished.length - this.keepFinished))) this.tasks.delete(t.info.id);
  }
}
