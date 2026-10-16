import { describe, expect, it } from 'vitest';
import { createAtm, type ToolPackageResult } from '@atm/core';
import { createApp } from '../src/app.js';
import { fixture, treeSnapshot } from './helpers.js';

it('previews and installs uploaded packages through the authenticated HTTP API', async () => {
  const f = await fixture();
  const atm = createAtm({ home: f.home, env: f.env });
  await atm.initSharedRepository({ root: f.root, mcpRegistry: `${f.root}/mcp-registry` });
  const app = createApp({ atm, token: 'test' });
  const source = { type: 'upload', filename: 'review.zip', base64: "UEsDBBQAAAAAAAAAAABDRSyqMAAAADAAAAAIAAAAU0tJTEwubWQtLS0KbmFtZTogcmV2aWV3CmRlc2NyaXB0aW9uOiBSZXZpZXcKLS0tClJldmlldy5QSwECFAMUAAAAAAAAAAAAQ0UsqjAAAAAwAAAACAAAAAAAAAAAAAAApIEAAAAAU0tJTEwubWRQSwUGAAAAAAEAAQA2AAAAVgAAAAAA" };
  const request = (body: unknown, authorized = true) => app.request('http://localhost/api/tool-packages', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer test' } : {}) }, body: JSON.stringify(body) });
  expect((await request({ source }, false)).status).toBe(401);
  const before = await treeSnapshot(f.root);
  const previewResponse = await request({ source });
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json() as ToolPackageResult;
  expect(preview.installed).toBe(false);
  expect(await treeSnapshot(f.root)).toEqual(before);
  expect((await request({ source, sha256: preview.sha256 })).status).toBe(200);
  expect((await atm.library()).map((t) => t.name)).toContain('review');
  expect((await request({ source, sha256: preview.sha256 })).status).toBe(409);
});

describe('upload validation', () => {
  it('rejects invalid sources, malformed JSON and oversized bodies', async () => {
    const f = await fixture();
    const app = createApp({ atm: createAtm({ home: f.home }), token: 'test' });
    const request = (body: string) => app.request('http://localhost/api/tool-packages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body });
    for (const body of ['oops', '{}', '{"source":{"type":"file"}}', '{"source":{"type":"upload","filename":"tools.zip"}}']) expect((await request(body)).status).toBe(400);
    expect((await request('x'.repeat(28 * 1024 * 1024 + 1))).status).toBe(413);
  });
});

it('routes directory, GitHub, MCP package sources and external searches with authentication', async () => {
  const f = await fixture();
  const atm = createAtm({ home: f.home, env: f.env });
  await atm.initSharedRepository({ root: f.root, mcpRegistry: `${f.root}/mcp-registry` });
  const app = createApp({ atm, token: 'test' });
  const { vi } = await import('vitest');
  const result = { installed: false, sha256: 'a'.repeat(64), tools: [], totalBytes: 0 };
  const importer = vi.spyOn(atm, 'importToolPackage').mockResolvedValue(result);
  const search = vi.spyOn(atm, 'searchExternalTools').mockResolvedValue({ items: [], warnings: [] });
  try {
    for (const source of [{ type: 'directory', path: '/tmp/tools' }, { type: 'github', repo: 'team/repo', ref: 'v1', path: 'skills/review' }, { type: 'mcp', spec: 'npm:@team/server' }]) {
      const res = await app.request('http://localhost/api/tool-packages', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ source, selection: ['skill:review'] }) });
      expect(res.status).toBe(200);
      expect(importer).toHaveBeenLastCalledWith({ source, selection: ['skill:review'], sha256: undefined });
    }
    expect((await app.request('http://localhost/api/external-tools?q=review&kind=skill')).status).toBe(401);
    expect((await app.request('http://localhost/api/external-tools?q=review&kind=skill', { headers: { Authorization: 'Bearer test' } })).status).toBe(200);
    expect(search).toHaveBeenCalledWith({ query: 'review', kind: 'skill' });
  } finally { importer.mockRestore(); search.mockRestore(); }
});
