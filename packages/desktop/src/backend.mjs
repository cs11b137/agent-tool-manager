import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@atm/server';

// Finder does not inherit the terminal's PATH. Recover it without interpolating user input.
// The bounded lookup is optional: a broken shell profile must not prevent the app from opening.
if (process.platform !== 'win32' && process.env.ATM_DESKTOP_NO_LOGIN_PATH !== '1') {
  try {
    const output = execFileSync(process.env.SHELL || '/bin/sh', ['-ilc', 'printf "\\n__ATM_PATH__%s__ATM_END__" "$PATH"'], {
      cwd: os.homedir(), encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const recovered = output.match(/__ATM_PATH__(.*?)__ATM_END__/s)?.[1];
    if (recovered) process.env.PATH = recovered;
  } catch { /* Fall back to the inherited PATH and the bundled Node runtime. */ }
}
process.env.PATH = [path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter);

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
if (!fs.existsSync(path.join(uiDir, 'index.html'))) throw new Error('Desktop UI resources are missing. Rebuild the application.');

let running;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 3000);
  deadline.unref();
  await running?.close();
  process.exit(0);
}
// The parent owns stdin. Even an unexpected desktop crash closes the pipe and stops the server.
process.stdin.resume();
process.stdin.on('end', () => void stop());
process.stdin.on('error', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
// A stable loopback origin preserves the existing UI's locale/theme preferences across launches.
// The bearer token remains fresh on every launch; occupied ports fall back to a random free port.
const portFile = path.join(os.homedir(), '.config', 'atm', 'desktop.json');
let preferredPort = 0;
try {
  const { port } = JSON.parse(await fsp.readFile(portFile, 'utf8'));
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) preferredPort = port;
} catch { /* First launch or invalid desktop preferences. */ }
try { running = await startServer({ uiDir, port: preferredPort }); }
catch (error) {
  if (!preferredPort || error.code !== 'EADDRINUSE') throw error;
  running = await startServer({ uiDir });
}
const temporaryPortFile = `${portFile}.${process.pid}.tmp`;
try {
  await fsp.mkdir(path.dirname(portFile), { recursive: true });
  await fsp.writeFile(temporaryPortFile, JSON.stringify({ port: running.port }) + '\n', { mode: 0o600 });
  await fsp.rename(temporaryPortFile, portFile);
} catch {
  // Preferences may be read-only; this must not prevent using the workspace.
  await fsp.rm(temporaryPortFile, { force: true }).catch(() => {});
}
if (stopping) await running.close();
else process.stdout.write(JSON.stringify({ type: 'ready', url: running.url }) + '\n');
