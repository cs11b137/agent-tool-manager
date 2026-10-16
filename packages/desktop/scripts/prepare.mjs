import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const resources = path.join(root, 'src-tauri/resources');
const runtime = path.join(resources, 'runtime');
const pnpmEntry = process.env.npm_execpath;
function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}
// Cross-compilation would silently bundle the host's Node; require a native build instead.
const rustHost = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || rustHost;
const rustArch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
if (target !== rustHost || !rustArch || !rustHost?.startsWith(`${rustArch}-`)) {
  throw new Error('Build the desktop app on its target OS/architecture; cross-bundling Node is not supported.');
}
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Desktop builds require Node 22 or newer.');

if (!pnpmEntry) throw new Error('Run this script through pnpm --filter @atm/desktop build.');
// Invoke the JS entry directly: execFile cannot launch pnpm.cmd on Windows.
run(process.execPath, [pnpmEntry, '--filter', '@atm/server...', 'build']);
run(process.execPath, [pnpmEntry, '--filter', '@atm/ui', 'build']);
await fs.mkdir(runtime, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/backend.mjs')], outfile: path.join(resources, 'backend.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false,
  // ZIP decoding uses CommonJS dependencies that require Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await fs.rm(path.join(resources, 'ui'), { recursive: true, force: true });
await fs.cp(path.join(root, '../ui/dist'), path.join(resources, 'ui'), { recursive: true });

// Official Node distributions are portable. Reject Homebrew/dynamically linked local builds.
if (process.platform === 'darwin') {
  const links = execFileSync('otool', ['-L', process.execPath], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean);
  if (links.some(line => !/^\s*\/(System\/Library|usr\/lib)\//.test(line))) {
    throw new Error('Use an official Node distribution (e.g. nodejs.org/fnm); this Node depends on local libraries.');
  }
}
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
await fs.copyFile(process.execPath, path.join(runtime, nodeName));
await fs.chmod(path.join(runtime, nodeName), 0o755);
// Ship the runtime's license, including its bundled third-party notices.
const licenseFile = path.join(runtime, 'LICENSE');
const versionFile = path.join(runtime, 'version.json');
const old = await fs.readFile(versionFile, 'utf8').then(JSON.parse, () => null);
if (old?.version !== process.version || !(await fs.stat(licenseFile).catch(() => null))) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!response.ok) throw new Error(`Cannot fetch Node license (${response.status})`);
  await fs.writeFile(licenseFile, await response.text());
}
const sha256 = createHash('sha256').update(await fs.readFile(path.join(runtime, nodeName))).digest('hex');
await fs.writeFile(versionFile, JSON.stringify({ version: process.version, platform: process.platform, arch: process.arch, sha256 }, null, 2) + '\n');
console.log(`Desktop resources ready: Node ${process.version} (${process.platform}/${process.arch}), UI and server bundled.`);
