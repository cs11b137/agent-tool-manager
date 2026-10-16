import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { downloadPackage, isPublicAddress } from '../src/ops/package-download.js';

afterEach(() => { vi.resetAllMocks(); });
function reply(status: number, headers = {}, bytes = Buffer.from('zip')) {
  mocks.request.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => callback(Object.assign(Readable.from([bytes]), { statusCode: status, headers }));
    return req;
  });
}

describe('package download', () => {
  it.each(['127.0.0.1', '10.1.1.1', '169.254.169.254', '192.168.1.1', '172.16.1.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::'])('blocks nonpublic address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it('allows public addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('supports desktop fake-IP proxies only for known public service hosts', async () => {
    mocks.lookup.mockResolvedValue([{ address: '198.18.0.59', family: 4 }]);
    expect(isPublicAddress('198.18.0.59')).toBe(false);
    reply(200);
    await expect(downloadPackage('https://api.github.com/search/repositories')).resolves.toEqual(Buffer.from('zip'));
    for (const url of ['https://example.com/tool.zip', 'https://api.github.com.evil.example/tool.zip', 'https://198.18.0.59/tool.zip']) {
      await expect(downloadPackage(url)).rejects.toThrow('本机或内网');
    }
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(downloadPackage('https://api.github.com/search/repositories')).rejects.toThrow('本机或内网');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('pins validated addresses and follows a public HTTPS redirect', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    reply(302, { location: 'https://cdn.example.com/archive.zip' }); reply(200);
    expect(await downloadPackage('https://example.com/tool.zip')).toEqual(Buffer.from('zip'));
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    const options = mocks.request.mock.calls[1]![1];
    const cb = vi.fn(); options.lookup('cdn.example.com', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    const cbSingle = vi.fn(); options.lookup('cdn.example.com', {}, cbSingle);
    expect(cbSingle).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });
  it('blocks redirects to private hosts and rejects non-HTTPS and credential URLs', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    reply(302, { location: 'https://localhost/private.zip' });
    await expect(downloadPackage('https://example.com/tool.zip')).rejects.toThrow('本机或内网');
    expect(mocks.request).toHaveBeenCalledTimes(1);
    for (const url of ['http://example.com/tool.zip', 'https://token@example.com/tool.zip', 'file:///tmp/tool.zip', 'https://example.com:8443/tool.zip']) {
      await expect(downloadPackage(url)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    }
  });
  it('handles HTTP errors, oversized streams, redirect loops and cancellation', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    reply(404); await expect(downloadPackage('https://example.com/tool.zip')).rejects.toThrow('HTTP 404');
    reply(200, { 'content-length': '999999999' }); await expect(downloadPackage('https://example.com/tool.zip')).rejects.toThrow('20 MB');
    reply(200, {}, Buffer.alloc(21 * 1024 * 1024)); await expect(downloadPackage('https://example.com/tool.zip')).rejects.toThrow('20 MB');
    for (let i = 0; i < 6; i++) reply(302, { location: '/again.zip' });
    await expect(downloadPackage('https://example.com/tool.zip')).rejects.toThrow('重定向次数');
    const ac = new AbortController(); ac.abort();
    await expect(downloadPackage('https://example.com/tool.zip', ac.signal)).rejects.toThrow();
  });
});
