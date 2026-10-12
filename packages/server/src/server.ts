import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createAtm, type Atm, type AtmEvent } from '@atm/core';
import { createApp } from './app.js';
import { EventHub } from './events.js';
import { TaskManager } from './tasks.js';

export interface ServerOptions {
  /** Pre-built Atm. When given, core events (activity / project.changed from writes) only reach SSE if you forward them to `RunningServer.hub.publish`; file-watch events always do. */
  atm?: Atm;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 0 / undefined → random free port */
  port?: number;
  host?: '127.0.0.1';
  uiDir?: string;
  token?: string;
  /** How often to re-read the project registry so projects registered by other processes get watched. Default 5000ms. */
  registryPollMs?: number;
}

export interface RunningServer {
  /** `http://127.0.0.1:<port>/?token=<token>` */
  url: string;
  port: number;
  token: string;
  app: Hono;
  /** Event bus behind `/api/events`. */
  hub: EventHub;
  close(): Promise<void>;
}

const WATCHED_SUBDIRS = ['.agents', '.agents/skills', '.agents/mcp', '.cursor', '.codex', '.claude'];

async function existing(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of WATCHED_SUBDIRS) {
    try {
      if ((await fs.stat(path.join(projectDir, sub))).isDirectory()) out.push(sub);
    } catch {
      // missing
    }
  }
  return out;
}

/** Keeps `atm.watch` in sync with the project registry. Refreshes are serialised. */
class ProjectWatcher {
  private key: string | null = null;
  private stop: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly atm: Atm,
    private readonly onEvent: (e: AtmEvent) => void,
  ) {}

  refresh = (): Promise<void> => {
    this.chain = this.chain.then(() => this.doRefresh()).catch(() => undefined);
    return this.chain;
  };

  private async doRefresh(): Promise<void> {
    if (this.stopped) return;
    const projects = [...(await this.atm.config()).projects].sort();
    // core's fs.watch skips directories that don't exist yet (e.g. `.agents/` before init), so the
    // key also covers which watchable directories exist: when one appears, the watch is restarted.
    const key = (await Promise.all(projects.map(async (p) => `${p}:${(await existing(p)).join(',')}`))).join('\n');
    if (key === this.key || this.stopped) return;
    this.key = key;
    this.stop?.();
    // an empty list means "all registered" to core, which is also empty here; registry dir is still watched
    this.stop = this.atm.watch(projects, this.onEvent);
  }

  close(): void {
    this.stopped = true;
    this.stop?.();
    this.stop = null;
  }
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const hostname = opts.host ?? '127.0.0.1';
  const hub = new EventHub();
  const tasks = new TaskManager(hub.publish);
  let watcher: ProjectWatcher | null = null;
  const refreshWatch = () => void watcher?.refresh();

  const fromCore = (e: AtmEvent) => {
    hub.publish(e);
    // any write may have auto-registered a project
    if (e.type === 'activity' || e.type === 'project.changed') refreshWatch();
  };
  const atm = opts.atm ?? createAtm({ home: opts.home, env: opts.env, onEvent: fromCore });
  const atmForTask = opts.atm
    ? undefined
    : (signal: AbortSignal, onEvent: (e: AtmEvent) => void) =>
        createAtm({
          home: opts.home,
          env: opts.env,
          signal,
          onEvent: (e) => {
            onEvent(e);
            if (e.type === 'activity' || e.type === 'project.changed') refreshWatch();
          },
        });

  let port: number | undefined;
  const app = createApp({ atm, token, uiDir: opts.uiDir, port: () => port, hub, tasks, atmForTask, onProjectsChanged: refreshWatch });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname }, () => resolve(s as Server)) as Server;
    s.once('error', reject);
  });
  port = (server.address() as AddressInfo).port;

  watcher = new ProjectWatcher(atm, hub.publish);
  await watcher.refresh();
  const poll = setInterval(refreshWatch, opts.registryPollMs ?? 5000);
  poll.unref();

  let closing: Promise<void> | null = null;
  return {
    url: `http://${hostname}:${port}/?token=${encodeURIComponent(token)}`,
    port,
    token,
    app,
    hub,
    close() {
      closing ??= new Promise<void>((resolve) => {
        clearInterval(poll);
        watcher?.close();
        tasks.cancelAll();
        hub.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      return closing;
    },
  };
}
