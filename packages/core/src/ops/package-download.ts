import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { AtmError } from '../errors.js';

export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

// Some desktop VPNs use the benchmarking range as fake-IP DNS for public services.
// Permit it only for these fixed service hosts, never arbitrary URLs or literal IPs.
const proxyHosts = new Set(['api.github.com', 'github.com', 'raw.githubusercontent.com', 'codeload.github.com', 'registry.modelcontextprotocol.io', 'registry.npmjs.org', 'pypi.org']);
const fakeIp = new BlockList();
fakeIp.addSubnet('198.18.0.0', 15, 'ipv4');
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  return family === 4 ? !blocked.check(ip, 'ipv4') : family === 6 && globalV6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}

export async function downloadPackage(source: string, signal?: AbortSignal): Promise<Buffer> {
  const deadline = AbortSignal.timeout(60_000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let next = source;
  for (let redirects = 0; redirects <= 5; redirects++) {
    abort.throwIfAborted();
    let url: URL;
    try { url = new URL(next); } catch { throw new AtmError('INVALID_MANIFEST', '请输入有效的 HTTPS 下载地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      throw new AtmError('INVALID_MANIFEST', '下载地址必须使用 HTTPS 默认端口，且不能包含账号或密码');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await lookup(host, { all: true });
    abort.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address) && !(proxyHosts.has(host) && fakeIp.check(address, 'ipv4')))) throw new AtmError('INVALID_MANIFEST', '下载地址不能指向本机或内网');
    // Pin validated DNS results to this request, including every redirect.
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request(url, { signal: abort, headers: { Accept: 'application/json, application/zip, text/plain, */*', 'User-Agent': 'Agent-Tool-Manager' }, lookup: (_host, options, cb) => {
        if (options.all) cb(null, addresses);
        else cb(null, addresses[0]!.address, addresses[0]!.family);
      } }, resolve);
      req.on('error', reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new AtmError('INVALID_MANIFEST', '下载重定向缺少目标地址');
      next = new URL(location, url).href;
      continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw new AtmError('INVALID_MANIFEST', `下载失败：HTTP ${response.statusCode}`); }
    if (Number(response.headers['content-length']) > MAX_PACKAGE_BYTES) { response.destroy(); throw new AtmError('INVALID_MANIFEST', '工具包不能超过 20 MB'); }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_PACKAGE_BYTES) { response.destroy(); throw new AtmError('INVALID_MANIFEST', '工具包不能超过 20 MB'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new AtmError('INVALID_MANIFEST', '下载重定向次数过多');
}
