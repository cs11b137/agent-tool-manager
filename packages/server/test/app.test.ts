import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAtm, type AtmEvent } from '@atm/core';
import { createApp, EventHub, TaskManager } from '../src/index.js';
import { fixture, mkTmp, write } from './helpers.js';

const PORT = 45123;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

async function makeApp(uiDir?: string) {
  const f = await fixture();
  const hub = new EventHub({ debounceMs: 0 });
  const atm = createAtm({ home: f.home, env: f.env, onEvent: hub.publish });
  const app = createApp({ atm, token: TOKEN, port: PORT, hub, ...(uiDir ? { uiDir } : {}) });
  return { ...f, app, hub, atm };
}

describe('auth / host / origin', () => {
  it('401 without token, 401 with wrong token, 200 with token', async () => {
    const { app } = await makeApp();
    const none = await app.request(`${BASE}/api/config`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect((await app.request(`${BASE}/api/config`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await app.request(`${BASE}/api/config`, { headers: auth });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('application/json');
    expect(await ok.json()).toMatchObject({ defaultAgents: ['claude-code'], projects: [] });
  });

  it('?token= is only accepted on /api/events', async () => {
    const { app } = await makeApp();
    expect((await app.request(`${BASE}/api/config?token=${TOKEN}`)).status).toBe(401);
    const ac = new AbortController();
    const res = await app.request(`${BASE}/api/events?token=${TOKEN}`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
    ac.abort();
  });

  it('SSE sends keep-alive pings', async () => {
    const f = await fixture();
    const atm = createAtm({ home: f.home, env: f.env });
    const app = createApp({ atm, token: TOKEN, port: PORT, pingIntervalMs: 20 });
    const res = await app.request(`${BASE}/api/events`, { headers: auth });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes(': ping\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
  });

  it('403 with a foreign Origin or Host', async () => {
    const { app } = await makeApp();
    const badOrigin = await app.request(`${BASE}/api/config`, { headers: { ...auth, Origin: 'http://evil.example' } });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect((await app.request(`${BASE}/api/config`, { headers: { ...auth, Origin: `http://localhost:${PORT + 1}` } })).status).toBe(403);
    expect((await app.request(`${BASE}/api/config`, { headers: { ...auth, Origin: `http://localhost:${PORT}` } })).status).toBe(200);
    expect((await app.request(`${BASE}/api/config`, { headers: { ...auth, Origin: BASE } })).status).toBe(200);
    expect((await app.request(`http://evil.example:${PORT}/api/config`, { headers: auth })).status).toBe(403);
    // static files are also protected against DNS rebinding
    expect((await app.request(`http://evil.example:${PORT}/`)).status).toBe(403);
  });
});

describe('error mapping & validation', () => {
  it('unknown project → 404 with AtmErrorJson', async () => {
    const { app } = await makeApp();
    const res = await app.request(`${BASE}/api/projects/deadbeef0000`, { headers: auth });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string; nextCommand?: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('deadbeef0000');
    expect(typeof body.error.nextCommand).toBe('string');
  });

  it('bad bodies → 400 INVALID_MANIFEST', async () => {
    const { app } = await makeApp();
    const post = (p: string, body: string) => app.request(`${BASE}${p}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body });
    for (const [p, body] of [
      ['/api/projects', '{}'],
      ['/api/projects', 'not json'],
      ['/api/batch', '{"ops": 1}'],
      ['/api/mcp-defs', '{"def": {"name": "x"}, "scope": "registry"}'],
      ['/api/global/migrate', '{"kind": "mcp", "name": "x", "projectIds": []}'],
    ] as const) {
      const res = await post(p, body);
      expect(res.status, `${p} ${body}`).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'INVALID_MANIFEST' } });
    }
    const patch = await app.request(`${BASE}/api/config`, { method: 'PATCH', headers: auth, body: '{"defaultAgents": ["vim"]}' });
    expect(patch.status).toBe(400);
  });

  it('unknown api route and unknown task → 404', async () => {
    const { app } = await makeApp();
    expect((await app.request(`${BASE}/api/nope`, { headers: auth })).status).toBe(404);
    const t = await app.request(`${BASE}/api/tasks/abc`, { headers: auth });
    expect(t.status).toBe(404);
    expect(await t.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('accepts an absolute path as project id', async () => {
    const { app, project } = await makeApp();
    const dir = await project();
    const reg = await app.request(`${BASE}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ path: dir }) });
    expect(reg.status).toBe(200);
    const res = await app.request(`${BASE}/api/projects/${encodeURIComponent(dir)}/init`, { method: 'POST', headers: auth, body: '{"dryRun": true}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false });
    // uninitialised project detail → 409 NOT_INITIALIZED
    const detail = await app.request(`${BASE}/api/projects/${encodeURIComponent(dir)}`, { headers: auth });
    expect(detail.status).toBe(409);
    expect(await detail.json()).toMatchObject({ error: { code: 'NOT_INITIALIZED' } });
  });
});

describe('static UI', () => {
  it('without uiDir, / says the UI is not built', async () => {
    const { app } = await makeApp();
    const res = await app.request(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('UI is not built');
  });

  it('serves files with SPA fallback and no auth', async () => {
    const ui = await mkTmp('atm-ui-');
    await write(path.join(ui, 'index.html'), '<!doctype html><div id="root"></div>');
    await write(path.join(ui, 'assets', 'app.js'), 'console.log(1)');
    const { app } = await makeApp(ui);
    const idx = await app.request(`${BASE}/?token=${TOKEN}`);
    expect(idx.status).toBe(200);
    expect(idx.headers.get('content-type')).toContain('text/html');
    const js = await app.request(`${BASE}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await js.text()).toBe('console.log(1)');
    const spa = await app.request(`${BASE}/projects/abc`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('id="root"');
    expect((await app.request(`${BASE}/assets/missing.js`)).status).toBe(404);
    const outside = path.join(path.dirname(ui), 'secret.txt');
    await fs.writeFile(outside, 'secret');
    try {
      const trav = await app.request(`${BASE}/..%2Fsecret.txt`);
      expect(await trav.text()).not.toContain('secret');
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

describe('TaskManager', () => {
  it('cancel aborts the signal and emits task.cancelled', async () => {
    const events: AtmEvent[] = [];
    const tm = new TaskManager((e) => events.push(e));
    let aborted = false;
    const id = tm.start('slow', (t) => new Promise((_resolve, reject) => t.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })));
    expect(tm.get(id)).toMatchObject({ status: 'running', title: 'slow' });
    await new Promise((r) => setImmediate(r));
    expect(tm.cancel(id)).toMatchObject({ status: 'cancelled' });
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
    expect(tm.get(id)?.status).toBe('cancelled');
    expect(events.map((e) => e.type)).toEqual(['task.started', 'task.cancelled']);
  });

  it('reports progress, done and failed', async () => {
    const events: AtmEvent[] = [];
    const tm = new TaskManager((e) => events.push(e));
    const ok = tm.start('ok', async (t) => {
      t.progress('half', 50);
      return 42;
    });
    const bad = tm.start('bad', async () => {
      throw new Error('boom');
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(tm.get(ok)).toMatchObject({ status: 'done', result: 42, progress: { message: 'half', percent: 50 } });
    expect(tm.get(bad)).toMatchObject({ status: 'failed', error: 'boom' });
    expect(events.map((e) => e.type).sort()).toEqual(['task.done', 'task.failed', 'task.progress', 'task.started', 'task.started']);
  });
});

describe('EventHub', () => {
  it('debounces change events per project and keeps the last 50 activity entries newest first', async () => {
    const hub = new EventHub({ debounceMs: 20 });
    const got: AtmEvent[] = [];
    hub.subscribe((e) => got.push(e));
    hub.publish({ type: 'project.changed', projectId: 'a', reason: 'manifest' });
    hub.publish({ type: 'project.changed', projectId: 'a', reason: 'agent-config' });
    hub.publish({ type: 'project.changed', projectId: 'b', reason: 'manifest' });
    for (let i = 0; i < 60; i++) hub.publish({ type: 'activity', entry: { at: new Date().toISOString(), level: 'info', message: `m${i}` } });
    expect(got.filter((e) => e.type === 'activity')).toHaveLength(60);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.filter((e) => e.type === 'project.changed')).toEqual([
      { type: 'project.changed', projectId: 'a', reason: 'agent-config' },
      { type: 'project.changed', projectId: 'b', reason: 'manifest' },
    ]);
    const recent = hub.recentActivity();
    expect(recent).toHaveLength(50);
    expect(recent[0]!.message).toBe('m59');
    expect(recent[49]!.message).toBe('m10');
    hub.close();
  });
});

describe('shared directory endpoint', () => {
  it('requires auth, validates both paths and initializes the real filesystem', async () => {
    const { app, home, atm } = await makeApp();
    const url = `${BASE}/api/config/init-shared-directory`;
    expect((await app.request(url, { method: 'POST' })).status).toBe(401);
    for (const body of [{}, { root: '~/tools' }, { root: 'relative', mcpRegistry: '~/registry' }, { root: '~/tools', mcpRegistry: '' }, { root: '~/tools', mcpRegistry: '~/registry', force: true }]) {
      expect((await app.request(url, { method: 'POST', headers: auth, body: JSON.stringify(body) })).status).toBe(400);
    }
    const body = JSON.stringify({ root: '~/shared/deep', mcpRegistry: '~/shared/deep/mcp-registry' });
    const response = await app.request(url, { method: 'POST', headers: auth, body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await atm.config());
    expect((await fs.stat(path.join(home, 'shared/deep/mcp-registry'))).isDirectory()).toBe(true);
    expect((await app.request(url, { method: 'POST', headers: auth, body })).status).toBe(200);
    await fs.writeFile(path.join(home, 'blocked'), 'keep');
    expect((await app.request(url, { method: 'POST', headers: auth, body: JSON.stringify({ root: '~/blocked', mcpRegistry: '~/registry' }) })).status).toBe(409);
    expect((await atm.config()).root).toBe(path.join(home, 'shared/deep'));
  });
});

describe('managed library and explicit plugin discovery', () => {
  it('keeps native installed plugins out of the default library and search results', async () => {
    const { app, home } = await makeApp();
    const installPath = path.join(home, '.claude/plugins/cache/native');
    await fs.mkdir(installPath, { recursive: true });
    await write(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'native@market': [{ scope: 'user', installPath, version: '1.0.0' }] } }));
    for (const query of ['', '?q=native', '?includeInstalledPlugins=0']) {
      const response = await app.request(`${BASE}/api/library${query}`, { headers: auth });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }
    for (const query of ['?includeInstalledPlugins=1', '?q=native&includeInstalledPlugins=1']) {
      const response = await app.request(`${BASE}/api/library${query}`, { headers: auth });
      expect(await response.json()).toEqual([expect.objectContaining({ name: 'native@market', usedBy: [] })]);
    }
  });
});

describe('shared repository endpoints', () => {
  it('authenticates, validates, initializes and creates real tools', async () => {
    const { app, atm } = await makeApp();
    const post = (route: string, body: unknown) => app.request(`${BASE}/api/shared-repository${route}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const route of ['/init', '/tools', '/commit', '/push']) expect((await app.request(`${BASE}/api/shared-repository${route}`, { method: 'POST' })).status).toBe(401);
    expect((await app.request(`${BASE}/api/shared-repository/remote`, { method: 'PUT' })).status).toBe(401);
    expect((await post('/init', { root: 'relative', mcpRegistry: '/tmp/registry' })).status).toBe(400);
    expect((await post('/tools', { kind: 'unknown' })).status).toBe(400);
    expect((await post('/commit', { message: '' })).status).toBe(400);
    const cfg = await atm.config();
    expect((await post('/init', { root: cfg.root, mcpRegistry: cfg.mcpRegistry, defaultAgents: ['bad'] })).status).toBe(400);
    expect((await post('/init', { root: cfg.root, mcpRegistry: cfg.mcpRegistry, defaultAgents: ['claude-code', 'cursor'] })).status).toBe(200);
    expect((await atm.config()).defaultAgents).toEqual(['claude-code', 'cursor']);
    const state = await app.request(`${BASE}/api/shared-repository`, { headers: auth });
    expect(await state.json()).toMatchObject({ initialized: true, root: cfg.root, head: '' });
    for (const kind of ['skill', 'plugin']) {
      const input = { kind, name: `my-${kind}`, description: 'My tool', content: '# Instructions\nDo useful work.' };
      const res = await post('/tools', input);
      expect(res.status).toBe(200);
      const result = await res.json() as { path: string };
      expect(await fs.stat(result.path)).toBeDefined();
      expect((await post('/tools', input)).status).toBe(409);
    }
    expect((await post('/tools', { kind: 'mcp', def: { name: 'local-mcp', transport: 'http', url: 'https://example.com/mcp' } })).status).toBe(200);
    expect((await post('/tools', { kind: 'mcp', def: {} })).status).toBe(400);
    expect((await atm.library()).map((i) => i.name)).toEqual(expect.arrayContaining(['my-skill', 'my-plugin@atm-shared', 'local-mcp']));
  });
});
