import type { ActivityEntry, AtmEvent } from '@atm/core';

export interface EventHubOptions {
  /** Debounce window for `project.changed` / `library.changed`, per project. Default 300ms. */
  debounceMs?: number;
  /** Activity ring buffer size. Default 50. */
  activityLimit?: number;
}

interface Subscriber {
  send: (e: AtmEvent) => void;
  end: () => void;
}

/**
 * In-process event bus behind `GET /api/events`.
 * - `activity` events are kept in a ring buffer (newest last internally).
 * - change notifications are debounced per project so a write that triggers both the core
 *   `onEvent` callback and several `fs.watch` callbacks reaches clients once.
 * - task events and activity are delivered immediately.
 */
export class EventHub {
  private readonly subs = new Set<Subscriber>();
  private readonly activity: ActivityEntry[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private readonly activityLimit: number;
  private closed = false;

  constructor(opts: EventHubOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.activityLimit = opts.activityLimit ?? 50;
  }

  publish = (e: AtmEvent): void => {
    if (this.closed) return;
    if (e.type === 'activity') {
      this.activity.push(e.entry);
      if (this.activity.length > this.activityLimit) this.activity.splice(0, this.activity.length - this.activityLimit);
    }
    const key = e.type === 'project.changed' ? `project:${e.projectId}` : e.type === 'library.changed' ? 'library' : null;
    if (key === null || this.debounceMs <= 0) {
      this.broadcast(e);
      return;
    }
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(key);
      this.broadcast(e);
    }, this.debounceMs);
    t.unref?.();
    this.timers.set(key, t);
  };

  /** Newest first. */
  recentActivity(): ActivityEntry[] {
    return [...this.activity].reverse();
  }

  subscribe(send: (e: AtmEvent) => void, end: () => void = () => undefined): () => void {
    const sub: Subscriber = { send, end };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const s of [...this.subs]) {
      try {
        s.end();
      } catch {
        // ignore
      }
    }
    this.subs.clear();
  }

  private broadcast(e: AtmEvent): void {
    if (this.closed) return;
    for (const s of [...this.subs]) {
      try {
        s.send(e);
      } catch {
        // a broken subscriber must not affect others
      }
    }
  }
}
