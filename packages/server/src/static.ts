import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

async function readFileIfExists(file: string): Promise<Buffer | null> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export async function dirExists(dir: string | undefined): Promise<boolean> {
  if (!dir) return false;
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Serves `uiDir` with SPA fallback: unknown extension-less paths get `index.html`;
 * missing files with an extension (e.g. a stale `/assets/x.js`) are 404.
 */
export async function serveStatic(uiDir: string, urlPath: string, method: string): Promise<Response> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  const root = path.resolve(uiDir);
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (file !== root && !file.startsWith(root + path.sep)) return new Response('Not Found', { status: 404 });

  const head = method === 'HEAD';
  const send = (body: Buffer, f: string, cache: string) =>
    new Response(head ? null : new Uint8Array(body), {
      status: 200,
      headers: { 'Content-Type': contentType(f), 'Content-Length': String(body.length), 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
    });

  if (file !== root) {
    const body = await readFileIfExists(file);
    if (body) {
      const immutable = rel.startsWith('/assets/') && path.extname(file) !== '.html';
      return send(body, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    if (path.extname(file) !== '') return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const index = path.join(root, 'index.html');
  const body = await readFileIfExists(index);
  if (!body) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return send(body, index, 'no-cache');
}

export const UI_NOT_BUILT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>atm</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1em .3em;border-radius:4px}</style>
</head><body>
<h1>atm server is running</h1>
<p>The web UI is not built. Build it with <code>pnpm --filter @atm/ui build</code> and restart <code>atm ui</code>.</p>
<p>The JSON API is available under <code>/api</code>.</p>
</body></html>
`;
