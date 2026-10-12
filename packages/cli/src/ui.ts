import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAtm, type Atm, type AtmEvent } from '@atm/core';
import type { Colors } from './output.js';

/** Shape of `startServer` exported by `@atm/server`. */
export interface StartServerOptions {
  atm: Atm;
  port?: number;
  open?: boolean;
  /** Directory with the built UI (index.html + assets). */
  uiDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  /** SSE event bus; core events from an injected Atm must be forwarded to it. */
  hub?: { publish(e: AtmEvent): void };
  close(): Promise<void>;
}

type ServerModule = { startServer(opts: StartServerOptions): Promise<RunningServer> };

export interface UiOptions {
  env: NodeJS.ProcessEnv;
  port?: number;
  open: boolean;
  projectId?: string;
  json: boolean;
  print(lines: string[]): void;
  stdout: NodeJS.WriteStream;
  out: Colors;
}

/** `dist/ui` in the published package; `packages/ui/dist` when running from source. */
export function resolveUiDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, 'ui'), path.resolve(here, '..', '..', 'ui', 'dist')]) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return undefined;
}

async function loadServer(): Promise<ServerModule> {
  // Non-literal specifier: keeps the CLI compilable even before @atm/server is built.
  const specifier = '@atm/server';
  return (await import(specifier)) as ServerModule;
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser available; the URL is printed anyway
  }
}

export async function runUi(o: UiOptions): Promise<number> {
  const server = await loadServer();
  const uiDir = resolveUiDir();
  // Forward core write events (activity / project.changed) to the server's SSE hub once it exists.
  let hub: RunningServer['hub'];
  const atm = createAtm({ env: o.env, onEvent: (e) => hub?.publish(e) });
  // The CLI opens the browser itself so it can deep-link into the project.
  const running = await server.startServer({ atm, ...(o.port !== undefined ? { port: o.port } : {}), ...(uiDir ? { uiDir } : {}) });
  hub = running.hub;

  const url = new URL(running.url);
  if (!url.searchParams.has('token')) url.searchParams.set('token', running.token);
  if (o.projectId) url.pathname = `/projects/${o.projectId}`;
  const href = url.toString();

  if (o.json) o.stdout.write(JSON.stringify({ url: href, port: running.port }, null, 2) + '\n');
  else {
    o.print([`${o.out.green('✔')} atm ui running at ${o.out.bold(href)}`, o.out.gray('  press Ctrl+C to stop')]);
  }
  if (o.open) openBrowser(href);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.close();
  return 0;
}
