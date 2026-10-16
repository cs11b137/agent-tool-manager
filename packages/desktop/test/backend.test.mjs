import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const resources = process.env.ATM_DESKTOP_RESOURCES || fileURLToPath(new URL('../src-tauri/resources/', import.meta.url));
const executable = path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'atm-desktop-'));
  const home = path.join(base, 'home');
  await fs.mkdir(home);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, home };
}
async function start(t, home) {
  const child = spawn(executable, [path.join(resources, 'backend.mjs')], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATM_DESKTOP_NO_LOGIN_PATH: '1', NODE_PATH: '', NODE_OPTIONS: '', PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); await exited; } });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill(), 10000);
  let ready;
  try {
    ready = await Promise.race([
      once(lines, 'line').then(([line]) => JSON.parse(line)),
      exited.then(() => { throw new Error(`Desktop service exited before ready: ${stderr}`); }),
    ]);
  } finally { clearTimeout(timeout); }
  assert.equal(ready.type, 'ready');
  const url = new URL(ready.url);
  assert.equal(url.hostname, '127.0.0.1');
  const token = url.searchParams.get('token');
  async function api(route, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(new URL(route, url), { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  }
  return { child, exited, url, token, api };
}

test('bundled runtime serves real UI and authenticated tool/project flow without external Node or node_modules', async t => {
  const { home, base } = await fixture(t);
  const service = await start(t, home);
  assert.match(await (await fetch(service.url)).text(), /<html/);
  assert.equal((await fetch(new URL('/api/config', service.url))).status, 401);
  assert.equal((await fetch(new URL('/api/config', service.url), { headers: { authorization: `Bearer ${service.token}`, origin: 'https://foreign.example' } })).status, 403);
  // The packaged backend must contain the same installation endpoints as the UI.
  const search = await fetch(new URL('/api/external-tools?q=x&kind=skill', service.url), { headers: { authorization: `Bearer ${service.token}` } });
  assert.equal(search.status, 400);
  assert.equal((await search.json()).error.code, 'INVALID_MANIFEST');
  assert.deepEqual(await service.api('/api/projects'), []);
  assert.deepEqual(await service.api('/api/library'), []);
  assert.equal((await service.api('/api/shared-repository')).initialized, false);
  const root = path.join(home, '.agent-tools');
  await service.api('/api/shared-repository/init', { root, mcpRegistry: path.join(root, 'mcp-registry') });
  const native = await service.api('/api/tool-packages', { source: { type: 'upload', filename: 'SKILL.md', base64: Buffer.from('---\nname: native-preview\ndescription: Native file\n---\nReview.').toString('base64') } });
  assert.equal(native.tools[0].name, 'native-preview');
  assert.equal(native.installed, false);
  await service.api('/api/shared-repository/tools', { kind: 'skill', name: 'desktop-skill', description: 'Desktop integration fixture', content: 'Use this test skill.' });
  const source = { type: 'upload', filename: 'review.zip', base64: 'UEsDBBQAAAAAAAAAAABDRSyqMAAAADAAAAAIAAAAU0tJTEwubWQtLS0KbmFtZTogcmV2aWV3CmRlc2NyaXB0aW9uOiBSZXZpZXcKLS0tClJldmlldy5QSwECFAMUAAAAAAAAAAAAQ0UsqjAAAAAwAAAACAAAAAAAAAAAAAAApIEAAAAAU0tJTEwubWRQSwUGAAAAAAEAAQA2AAAAVgAAAAAA' };
  const preview = await service.api('/api/tool-packages', { source });
  assert.equal(preview.installed, false);
  assert.equal(preview.tools[0].name, 'review');
  assert.equal((await service.api('/api/tool-packages', { source, sha256: preview.sha256 })).installed, true);
  assert.match(await fs.readFile(path.join(root, 'skills/review/SKILL.md'), 'utf8'), /Review/);
  const projectDir = path.join(base, 'project');
  await fs.mkdir(projectDir);
  const project = await service.api('/api/projects', { path: projectDir });
  await service.api(`/api/projects/${project.id}/init`, {});
  await service.api(`/api/projects/${project.id}/tools`, { kind: 'skill', repo: 'atm:shared', name: 'desktop-skill' });
  const target = await fs.realpath(path.join(projectDir, '.agents/skills/desktop-skill'));
  assert.equal(target, await fs.realpath(path.join(root, 'skills/desktop-skill')));
  assert.equal(execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim(), 'true');
  service.child.stdin.end();
  assert.equal((await service.exited)[0], 0);
  await assert.rejects(fetch(service.url));
});

test('parent pipe closure releases the server; restart keeps origin and rotates token', async t => {
  const { home } = await fixture(t);
  const first = await start(t, home);
  first.child.stdin.end();
  assert.equal((await first.exited)[0], 0);
  const second = await start(t, home);
  assert.equal(second.url.origin, first.url.origin);
  assert.notEqual(second.token, first.token);
  assert.deepEqual(await second.api('/api/projects'), []);
  second.child.kill('SIGTERM');
  assert.equal((await second.exited)[0], 0);
});

test('occupied preferred port falls back safely without connecting to another process', async t => {
  const { home } = await fixture(t);
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => occupied.close());
  const port = occupied.address().port;
  await fs.mkdir(path.join(home, '.config/atm'), { recursive: true });
  await fs.writeFile(path.join(home, '.config/atm/desktop.json'), JSON.stringify({ port }));
  const service = await start(t, home);
  assert.notEqual(Number(service.url.port), port);
  assert.deepEqual(await service.api('/api/projects'), []);
});
