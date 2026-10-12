import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AtmEvent, DoctorReport, ProjectDetail, ProjectSummary, WriteResult } from '@atm/core';
import { startServer, type RunningServer } from '../src/index.js';
import { fixture, makeRemote, onCleanup, skillMd, treeSnapshot, waitFor } from './helpers.js';

async function start(): Promise<{ srv: RunningServer; f: Awaited<ReturnType<typeof fixture>> }> {
  const f = await fixture();
  const srv = await startServer({ home: f.home, env: f.env, port: 0 });
  onCleanup(() => srv.close());
  return { srv, f };
}

function client(srv: RunningServer) {
  const base = `http://127.0.0.1:${srv.port}`;
  return async <T = unknown>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${srv.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
}

/** Opens the SSE stream and collects parsed events. */
async function openEvents(srv: RunningServer) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/events?token=${encodeURIComponent(srv.token)}`, { signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const events: AtmEvent[] = [];
  const raw: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          raw.push(frame);
          for (const line of frame.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as AtmEvent);
        }
      }
    } catch {
      // aborted
    }
  })();
  const close = async () => {
    ac.abort();
    await pump;
  };
  onCleanup(close);
  return { events, raw, close };
}

describe('startServer', () => {
  it('listens on 127.0.0.1 with a random port and a tokenised url', async () => {
    const { srv } = await start();
    expect(srv.port).toBeGreaterThan(0);
    expect(srv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}/?token=${srv.token}`);
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/projects`);
    expect(res.status).toBe(401);
    const ok = await fetch(`http://localhost:${srv.port}/api/projects`, { headers: { Authorization: `Bearer ${srv.token}` } }).catch(() => null);
    // localhost may resolve to ::1 where nothing listens; only assert when it connected
    if (ok) expect(ok.status).toBe(200);
  });

  it('full flow: register → init → add (dryRun, then real) → detail → remove → doctor', async () => {
    const { srv, f } = await start();
    const api = client(srv);
    const remote = await makeRemote(f.base, 'baoyu-skills', {
      'skills/design/baoyu-cover/SKILL.md': skillMd('baoyu-cover', 'Cover generator'),
      'README.md': '# skills\n',
    });
    const dir = await f.project();

    const reg = await api<ProjectSummary>('POST', '/api/projects', { path: dir });
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ path: dir, initialized: false, exists: true });
    const id = reg.body.id;
    expect((await api<ProjectSummary[]>('GET', '/api/projects')).body.map((p) => p.id)).toEqual([id]);

    const init = await api<WriteResult>('POST', `/api/projects/${id}/init`, {});
    expect(init.status).toBe(200);
    expect(init.body.applied).toBe(true);

    const spec = { kind: 'skill', repo: remote.bare, name: 'baoyu-cover' };
    const beforeDir = await treeSnapshot(dir);
    const beforeHome = await treeSnapshot(f.home);
    const dry = await api<WriteResult>('POST', `/api/projects/${id}/tools?dryRun=1`, spec);
    expect(dry.status).toBe(200);
    expect(dry.body.applied).toBe(false);
    expect(dry.body.files.length).toBeGreaterThan(0);
    expect(await treeSnapshot(dir)).toEqual(beforeDir);
    expect(await treeSnapshot(f.home)).toEqual(beforeHome);

    const add = await api<WriteResult>('POST', `/api/projects/${id}/tools`, spec);
    expect(add.status).toBe(200);
    expect(add.body.applied).toBe(true);
    expect(await fs.readlink(path.join(dir, '.agents/skills/baoyu-cover'))).toBe(path.join(f.root, 'baoyu-skills', 'skills/design/baoyu-cover'));

    const detail = await api<ProjectDetail>('GET', `/api/projects/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.tools.map((t) => `${t.kind}:${t.name}`)).toEqual(['skill:baoyu-cover']);

    const gen = await api<unknown[]>('GET', `/api/projects/${id}/generated`);
    expect(gen.status).toBe(200);
    expect(Array.isArray(gen.body)).toBe(true);

    const lib = await api<Array<{ name: string }>>('GET', '/api/library?q=cover');
    expect(lib.status).toBe(200);
    expect(lib.body.map((i) => i.name)).toContain('baoyu-cover');

    const dryRemove = await api<WriteResult>('DELETE', `/api/projects/${id}/tools/skill/baoyu-cover?dryRun=1`);
    expect(dryRemove.body.applied).toBe(false);
    const rm = await api<WriteResult>('DELETE', `/api/projects/${id}/tools/skill/baoyu-cover`);
    expect(rm.status).toBe(200);
    expect(rm.body.applied).toBe(true);
    expect((await api<ProjectDetail>('GET', `/api/projects/${id}`)).body.tools).toEqual([]);

    const doctor = await api<DoctorReport>('GET', '/api/doctor');
    expect(doctor.status).toBe(200);
    expect(doctor.body).toMatchObject({ measured: false, projects: [{ id }] });

    const pdoctor = await api<DoctorReport>('GET', `/api/projects/${id}/doctor`);
    expect(pdoctor.status).toBe(200);
    expect(pdoctor.body.projects.map((p) => p.id)).toEqual([id]);

    const patch = await api<WriteResult>('PATCH', `/api/projects/${id}?dryRun=1`, { agents: ['claude-code', 'cursor'] });
    expect(patch.status).toBe(200);
    expect(patch.body.applied).toBe(false);

    const activity = await api<Array<{ message: string; at: string }>>('GET', '/api/activity');
    expect(activity.body.length).toBeGreaterThanOrEqual(3);
    const times = activity.body.map((a) => a.at);
    expect([...times].sort().reverse()).toEqual(times);

    const unreg = await api('DELETE', `/api/projects/${id}`);
    expect(unreg).toEqual({ status: 200, body: { ok: true } });
    expect((await api<ProjectSummary[]>('GET', '/api/projects')).body).toEqual([]);
  });

  it('SSE delivers activity and project.changed events for writes', async () => {
    const { srv, f } = await start();
    const api = client(srv);
    const dir = await f.project();
    const sse = await openEvents(srv);
    await waitFor(async () => (sse.raw.length > 0 ? true : undefined));
    const { body } = await api<ProjectSummary>('POST', '/api/projects', { path: dir });
    expect((await api<WriteResult>('POST', `/api/projects/${body.id}/init`)).status).toBe(200);
    await waitFor(async () => (sse.events.some((e) => e.type === 'activity') ? true : undefined), 5000);
    await waitFor(async () => (sse.events.some((e) => e.type === 'project.changed' && e.projectId === body.id) ? true : undefined), 5000);
    await sse.close();
  });

  it('SSE picks up external edits via the file watcher', async () => {
    const { srv, f } = await start();
    const api = client(srv);
    const dir = await f.project();
    const { body } = await api<ProjectSummary>('POST', '/api/projects', { path: dir });
    await api('POST', `/api/projects/${body.id}/init`);
    const sse = await openEvents(srv);
    await new Promise((r) => setTimeout(r, 700)); // let the initial write events flush and the watcher (re)start
    sse.events.length = 0;
    const manifest = path.join(dir, '.agents', 'tools.json');
    const json = JSON.parse(await fs.readFile(manifest, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(manifest, JSON.stringify({ ...json, agents: ['claude-code', 'cursor'] }, null, 2) + '\n');
    await waitFor(async () => (sse.events.some((e) => e.type === 'project.changed' && e.projectId === body.id) ? true : undefined), 5000);
  });

  it('POST /api/sync returns a taskId that reaches done', async () => {
    const { srv } = await start();
    const api = client(srv);
    const sse = await openEvents(srv);
    const res = await api<{ taskId: string }>('POST', '/api/sync', {});
    expect(res.status).toBe(200);
    const { taskId } = res.body;
    expect(typeof taskId).toBe('string');
    const task = await waitFor(async () => {
      const t = await api<{ status: string; result?: unknown }>('GET', `/api/tasks/${taskId}`);
      return t.body.status === 'running' ? undefined : t.body;
    });
    expect(task).toMatchObject({ id: taskId, title: 'Sync all repos', status: 'done', result: { repos: [], updatedProjects: [] } });
    await waitFor(async () => (sse.events.some((e) => e.type === 'task.done' && e.taskId === taskId) ? true : undefined), 3000);
    expect(sse.events.some((e) => e.type === 'task.started' && e.taskId === taskId)).toBe(true);
    // cancelling a finished task leaves it as-is
    expect((await api<{ status: string }>('DELETE', `/api/tasks/${taskId}`)).body.status).toBe('done');
  });

  it('a failing long task reports failed (clone of a missing repo)', async () => {
    const { srv, f } = await start();
    const api = client(srv);
    const { body } = await api<{ taskId: string }>('POST', '/api/repos', { repo: path.join(f.base, 'nope.git') });
    const task = await waitFor(async () => {
      const t = await api<{ status: string; error?: string }>('GET', `/api/tasks/${body.taskId}`);
      return t.body.status === 'running' ? undefined : t.body;
    });
    expect(task.status).toBe('failed');
    expect(task.error).toBeTruthy();
  });

  it('rejects a rebinding Host header on the real socket', async () => {
    const { srv } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/projects', headers: { Host: `evil.example:${srv.port}`, Authorization: `Bearer ${srv.token}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('close() ends open SSE streams', async () => {
    const { srv } = await start();
    const sse = await openEvents(srv);
    await waitFor(async () => (sse.raw.length > 0 ? true : undefined));
    await srv.close();
    await sse.close();
  });
});
