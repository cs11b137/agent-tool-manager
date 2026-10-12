import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { AtmError, type Atm, type AtmEvent, type InstallOptions, type McpDefScope, type ProjectDetail, type WriteOptions } from '@atm/core';
import { BadRequest, toErrorResponse, type ServerErrorJson } from './errors.js';
import { EventHub } from './events.js';
import { dirExists, serveStatic, UI_NOT_BUILT_HTML } from './static.js';
import { TaskManager, type TaskContext } from './tasks.js';
import * as v from './validate.js';

export interface AppDeps {
  atm: Atm;
  token: string;
  /** Directory with the built UI (`index.html` + assets). */
  uiDir?: string;
  /**
   * Port the server listens on; used for the `Host` / `Origin` allow-list.
   * A function so `startServer` can fill it in after `listen`. When undefined the Host/Origin
   * port is not checked (only the hostname), which is meant for `app.request()` tests.
   */
  port?: number | (() => number | undefined);
  /** Event bus behind `/api/events`; wire core `onEvent` into `hub.publish`. Created when omitted. */
  hub?: EventHub;
  tasks?: TaskManager;
  /**
   * Builds a per-task `Atm` bound to an `AbortSignal` (core takes the signal at `createAtm` time),
   * so `DELETE /api/tasks/:id` actually aborts git / measure work. Without it tasks use `atm`
   * and cancellation only marks the task cancelled.
   */
  atmForTask?: (signal: AbortSignal, onEvent: (e: AtmEvent) => void) => Atm;
  /** Called after the project registry may have changed (register / unregister / relocate / init). */
  onProjectsChanged?: () => void;
  /** SSE keep-alive interval. Default 25s. */
  pingIntervalMs?: number;
}

const FLAG_TRUE = new Set(['1', 'true', 'yes', 'on']);

function flag(c: Context, name: string): boolean | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  return FLAG_TRUE.has(raw.toLowerCase());
}

/** Body write options overlaid with `?dryRun=1&adopt=1&force=1` query flags. */
function writeOpts(c: Context, body?: unknown): WriteOptions {
  const out = v.writeOptions(body);
  for (const k of ['dryRun', 'adopt', 'force'] as const) {
    const f = flag(c, k);
    if (f !== undefined) out[k] = f;
  }
  return out;
}

async function readBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest('request body is not valid JSON');
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function serverError(code: ServerErrorJson['error']['code'], message: string, nextCommand?: string): ServerErrorJson {
  return { error: nextCommand ? { code, message, nextCommand } : { code, message } };
}

export function createApp(deps: AppDeps): Hono {
  const { atm, token } = deps;
  const hub = deps.hub ?? new EventHub();
  const tasks = deps.tasks ?? new TaskManager(hub.publish);
  const pingMs = deps.pingIntervalMs ?? 25_000;
  const getPort = typeof deps.port === 'function' ? deps.port : () => deps.port as number | undefined;
  const projectsChanged = () => deps.onProjectsChanged?.();

  const app = new Hono();

  // ── errors ──
  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status);
  });

  // ── Host / Origin (DNS rebinding + CSRF) — applies to everything, including static files ──
  app.use('*', async (c, next) => {
    const port = getPort();
    const hostHeader = c.req.header('host') ?? new URL(c.req.url).host;
    const okHost = (h: string) => {
      if (port === undefined) return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);
      return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
    };
    if (!okHost(hostHeader)) return c.json(serverError('FORBIDDEN', `host not allowed: ${hostHeader}`), 403);
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let ok = false;
      try {
        const u = new URL(origin);
        ok = u.protocol === 'http:' && u.origin === origin && okHost(u.host);
      } catch {
        ok = false;
      }
      if (!ok) return c.json(serverError('FORBIDDEN', `origin not allowed: ${origin}`), 403);
    }
    await next();
  });

  // ── token auth on /api/* ──
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('authorization');
    let supplied: string | undefined;
    if (auth?.startsWith('Bearer ')) supplied = auth.slice(7).trim();
    else if (c.req.method === 'GET' && c.req.path === '/api/events') supplied = c.req.query('token');
    if (!supplied || !safeEqual(supplied, token)) {
      return c.json(serverError('UNAUTHORIZED', supplied ? 'invalid token' : 'missing token', 'atm ui'), 401);
    }
    await next();
  });

  const project = (c: Context) => atm.resolveProject(c.req.param('id') ?? '');

  /** Runs `fn` as a long task with a signal-bound Atm (when available); activity → task.progress. */
  const startTask = (title: string, fn: (a: Atm, t: TaskContext) => Promise<unknown>) => {
    const taskId = tasks.start(title, (t) => {
      const a = deps.atmForTask
        ? deps.atmForTask(t.signal, (e) => {
            hub.publish(e);
            if (e.type === 'activity') t.progress(e.entry.message);
          })
        : atm;
      return fn(a, t);
    });
    return { taskId };
  };

  // ── config ──
  app.get('/api/config', async (c) => c.json(await atm.config()));
  app.patch('/api/config', async (c) => {
    const patch = v.configPatch(await readBody(c));
    const cfg = await atm.saveConfig(patch);
    if (patch.projects) projectsChanged();
    return c.json(cfg);
  });

  // ── projects ──
  app.get('/api/projects', async (c) => c.json(await atm.projects()));
  app.post('/api/projects', async (c) => {
    const body = v.obj(await readBody(c));
    const summary = await atm.registerProject(v.reqStr(body, 'path'));
    projectsChanged();
    return c.json(summary);
  });
  app.get('/api/projects/:id', async (c) => c.json(await atm.list(await project(c))));
  app.delete('/api/projects/:id', async (c) => {
    await atm.unregisterProject(await project(c));
    projectsChanged();
    return c.json({ ok: true as const });
  });
  app.patch('/api/projects/:id', async (c) => {
    const body = v.obj(await readBody(c));
    const opts = writeOpts(c);
    let dir = await project(c);
    const newPath = v.optStr(body, 'path');
    const agentList = body.agents === undefined ? undefined : v.agents(body.agents);
    if (newPath && !opts.dryRun) {
      dir = (await atm.relocateProject(dir, newPath)).path;
      projectsChanged();
    }
    if (agentList) {
      const res = await atm.setAgents(dir, agentList, opts);
      if (opts.dryRun) return c.json(res);
    }
    return c.json(await detailOrSummary(dir));
  });

  /** `ProjectDetail` for initialised projects; for uninitialised ones a summary padded to the same shape. */
  async function detailOrSummary(dir: string): Promise<ProjectDetail> {
    try {
      return await atm.list(dir);
    } catch (e) {
      if (!(e instanceof AtmError) || e.code !== 'NOT_INITIALIZED') throw e;
      const id = atm.projectId(dir);
      const s = (await atm.projects()).find((p) => p.id === id);
      if (!s) throw e;
      return { ...s, manifestPath: path.join(dir, '.agents', 'tools.json'), tools: [], issues: [] };
    }
  }

  app.post('/api/projects/:id/init', async (c) => {
    const dir = await project(c);
    const res = await atm.init(dir, writeOpts(c, await readBody(c)));
    if (res.applied) projectsChanged();
    return c.json(res);
  });
  app.post('/api/projects/:id/tools', async (c) => {
    const dir = await project(c);
    const spec = v.addSpec(await readBody(c));
    return c.json(await atm.add(dir, spec, writeOpts(c)));
  });
  app.delete('/api/projects/:id/tools/:kind/:name', async (c) => {
    const dir = await project(c);
    const k = v.kind(c.req.param('kind'));
    return c.json(await atm.remove(dir, c.req.param('name'), { ...writeOpts(c), kind: k }));
  });
  app.post('/api/projects/:id/install', async (c) => {
    const dir = await project(c);
    const body = await readBody(c);
    const opts: InstallOptions = writeOpts(c, body);
    const strictBody = body === undefined ? undefined : v.optBool(v.obj(body), 'strict');
    const strict = flag(c, 'strict') ?? strictBody;
    if (strict !== undefined) opts.strict = strict;
    return c.json(await atm.install(dir, opts));
  });
  app.get('/api/projects/:id/generated', async (c) => c.json(await atm.diffGenerated(await project(c))));
  app.get('/api/projects/:id/doctor', async (c) => {
    const dir = await project(c);
    if (flag(c, 'measure')) {
      return c.json(startTask(`Doctor --measure: ${path.basename(dir)}`, (a) => a.doctor(dir, { measure: true })));
    }
    return c.json(await atm.doctor(dir));
  });
  app.post('/api/projects/:id/measure/:name', async (c) => {
    const dir = await project(c);
    const name = c.req.param('name');
    return c.json(startTask(`Measure MCP ${name}`, (a) => a.measure(dir, name)));
  });
  app.post('/api/projects/:id/pin', async (c) => {
    const dir = await project(c);
    const body = v.obj(await readBody(c));
    return c.json(await atm.pin(dir, v.reqStr(body, 'skill'), v.reqStr(body, 'rev'), writeOpts(c)));
  });

  // ── doctor ──
  app.get('/api/doctor', async (c) => {
    if (flag(c, 'measure')) return c.json(startTask('Doctor --measure: all projects', (a) => a.doctor('all', { measure: true })));
    return c.json(await atm.doctor('all'));
  });
  app.post('/api/doctor/fix', async (c) => {
    const body = v.obj(await readBody(c));
    return c.json(await atm.fix(v.strArr(body.issueIds, 'issueIds'), writeOpts(c)));
  });

  // ── library / repos / sync / mcp defs ──
  app.get('/api/library', async (c) => {
    const q = c.req.query('q')?.trim();
    return c.json(q ? (await atm.search(q)).items : await atm.library());
  });
  app.get('/api/repos', async (c) => c.json(await atm.repos()));
  app.post('/api/repos', async (c) => {
    const repo = v.reqStr(v.obj(await readBody(c)), 'repo');
    return c.json(startTask(`Clone ${repo}`, (a) => a.cloneRepo(repo)));
  });
  app.post('/api/sync', async (c) => {
    const body = await readBody(c);
    const repos = body === undefined ? undefined : v.obj(body).repos;
    const list = repos === undefined || repos === null ? undefined : v.strArr(repos, 'repos');
    const title = list?.length ? `Sync ${list.join(', ')}` : 'Sync all repos';
    return c.json(startTask(title, (a) => a.sync(list)));
  });
  app.post('/api/mcp-defs', async (c) => {
    const body = v.obj(await readBody(c));
    const def = v.mcpDef(body.def);
    let scope: McpDefScope;
    if (body.scope === 'registry') scope = 'registry';
    else if (v.isObj(body.scope)) scope = { projectDir: await atm.resolveProject(v.reqStr(body.scope, 'projectId', 'scope.projectId')) };
    else throw new BadRequest('"scope" must be "registry" or { projectId }');
    return c.json(await atm.saveMcpDef(def, scope));
  });

  // ── matrix / global ──
  app.post('/api/batch', async (c) => c.json(await atm.batch(v.batchOps(await readBody(c)), writeOpts(c))));
  app.get('/api/global', async (c) => c.json(await atm.global()));
  app.post('/api/global/migrate', async (c) => c.json(await atm.migrate(v.migrateSpec(await readBody(c)), writeOpts(c))));

  // ── activity / tasks ──
  app.get('/api/activity', (c) => c.json(hub.recentActivity()));
  app.get('/api/tasks/:id', (c) => {
    const t = tasks.get(c.req.param('id'));
    if (!t) throw new AtmError('NOT_FOUND', `task not found: ${c.req.param('id')}`, { nextCommand: 'atm ui' });
    return c.json(t);
  });
  app.delete('/api/tasks/:id', (c) => {
    const t = tasks.cancel(c.req.param('id'));
    if (!t) throw new AtmError('NOT_FOUND', `task not found: ${c.req.param('id')}`, { nextCommand: 'atm ui' });
    return c.json(t);
  });

  // ── SSE ──
  app.get('/api/events', (c) => {
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let done = false;
        const close = () => {
          if (done) return;
          done = true;
          unsubscribe();
          clearInterval(ping);
          signal.removeEventListener('abort', close);
          try {
            controller.close();
          } catch {
            // already closed / cancelled
          }
        };
        const send = (chunk: string) => {
          if (done) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };
        const unsubscribe = hub.subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`), close);
        const ping = setInterval(() => send(': ping\n\n'), pingMs);
        ping.unref?.();
        cleanup = close;
        signal.addEventListener('abort', close);
        send('retry: 3000\n: connected\n\n');
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND' as const, message: `no such endpoint: ${c.req.method} ${c.req.path}`, nextCommand: 'atm ui' } }, 404));

  // ── static UI ──
  app.on(['GET', 'HEAD'], '*', async (c) => {
    if (deps.uiDir && (await dirExists(deps.uiDir))) return serveStatic(deps.uiDir, c.req.path, c.req.method);
    if (c.req.path === '/' || c.req.path === '/index.html') return c.html(UI_NOT_BUILT_HTML);
    return c.text('Not Found', 404);
  });

  return app;
}
