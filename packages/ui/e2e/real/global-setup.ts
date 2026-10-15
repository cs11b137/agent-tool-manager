import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLI_BIN, REPO_ROOT, STATE_FILE, atm, cliEnv, git, type RealState } from './env';

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`;

declare global {
  // eslint-disable-next-line no-var
  var __atmUiProcess: ChildProcess | undefined;
}

export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(CLI_BIN) || !fs.existsSync(path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'ui', 'index.html'))) {
    throw new Error('packages/cli/dist (with dist/ui) is missing — run `pnpm -r build` first');
  }

  // realpath: macOS tmpdir is a symlink (/var → /private/var); core compares real paths
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'atm-e2e-')));
  const home = base;
  const root = path.join(home, '.agent-tools');
  const registry = path.join(root, 'mcp-registry');

  // MCP registry
  write(
    path.join(registry, 'figma.json'),
    JSON.stringify(
      { name: 'figma', description: 'Figma 设计稿读取', transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'], env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' } },
      null,
      2,
    ) + '\n',
  );
  write(
    path.join(registry, 'linear.json'),
    JSON.stringify(
      { name: 'linear', description: 'Linear 工单', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } },
      null,
      2,
    ) + '\n',
  );

  // local skill repo (not yet cloned into ~/.agent-tools)
  const repo = path.join(home, 'src', 'baoyu-skills');
  write(path.join(repo, 'skills', 'baoyu-comic', 'SKILL.md'), skillMd('baoyu-comic', '把文章改编成多格漫画，生成分镜脚本和画面提示词'));
  write(path.join(repo, 'skills', 'baoyu-cover', 'SKILL.md'), skillMd('baoyu-cover', '为文章生成封面图提示词，支持多种风格'));
  write(path.join(repo, 'README.md'), '# baoyu-skills\n');
  git(home, repo, 'init', '-q', '-b', 'main');
  git(home, repo, 'add', '-A');
  git(home, repo, 'commit', '-q', '-m', 'init');

  // Claude Code plugin index (version 2) + user settings
  const pluginName = 'security-guidance@claude-plugins-official';
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'security-guidance', '1.0.0');
  write(path.join(installPath, 'skills', 'sg', 'SKILL.md'), skillMd('sg', 'Security guidance: review code for common vulnerabilities'));
  write(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [pluginName]: [{ scope: 'user', installPath, version: '1.0.0', installedAt: '2026-10-01T00:00:00.000Z' }] } }, null, 2) + '\n',
  );
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: {} }, null, 2) + '\n');

  // two projects, initialised and registered via the real CLI
  const projGui = path.join(home, 'proj-gui');
  const projCli = path.join(home, 'proj-cli');
  for (const p of [projGui, projCli]) {
    fs.mkdirSync(p, { recursive: true });
    atm(home, ['init', '--cwd', p]);
    atm(home, ['projects', '--add', p, '--cwd', home]);
  }

  // atm ui --no-open --port 0
  const child = spawn(process.execPath, [CLI_BIN, 'ui', '--no-open', '--port', '0', '--cwd', home], {
    env: cliEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  globalThis.__atmUiProcess = child;
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`atm ui did not print a URL within 20s:\n${out}`)), 20_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      // eslint-disable-next-line no-control-regex
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\S*token=[A-Za-z0-9_-]+)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`atm ui exited (${code}) before printing a URL:\n${out}`));
    });
  });
  child.stdout!.on('data', (b: Buffer) => process.env.ATM_E2E_VERBOSE && process.stdout.write(`[atm ui] ${b}`));
  child.stderr!.on('data', (b: Buffer) => process.stderr.write(`[atm ui] ${b}`));

  const u = new URL(url);
  const initialized = await fetch(`${u.origin}/api/shared-repository/init`, { method: 'POST', headers: { Authorization: `Bearer ${u.searchParams.get('token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ root, mcpRegistry: registry }) });
  if (!initialized.ok) throw new Error(await initialized.text());
  const state: RealState = {
    base,
    home,
    repo,
    root,
    projGui,
    projCli,
    url,
    origin: u.origin,
    token: u.searchParams.get('token') ?? '',
    pid: child.pid ?? 0,
  };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  process.env.ATM_E2E_BASE_URL = u.origin;
}
