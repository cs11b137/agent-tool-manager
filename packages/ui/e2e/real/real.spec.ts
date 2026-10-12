/**
 * Acceptance (tech-design §12 P4): adding Skills / MCP / plugins to a project in `atm ui` has exactly the same effect as the CLI.
 * Runs the built GUI against the real `atm ui` server and core with an isolated temp HOME (see global-setup.ts).
 */
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atm, readState } from './env';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const S = readState();
const projectId = (dir: string) => createHash('sha1').update(dir).digest('hex').slice(0, 12);
const PLUGIN = 'security-guidance@claude-plugins-official';
const read = (p: string) => fs.readFileSync(p, 'utf8');
const readJson = (p: string) => JSON.parse(read(p)) as Record<string, any>;

test.describe.configure({ mode: 'serial' });

let page: Page;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  // one tab for the whole run: the token from `?token=` lives in this tab's sessionStorage
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(S.url);
});

test.afterAll(async () => {
  await page.close();
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

async function settle() {
  await page.waitForTimeout(1200);
}

async function shot(name: string, fullPage = true) {
  await settle();
  await page.screenshot({ path: path.join(SHOTS, name), fullPage, animations: 'disabled' });
}

/** In-app navigation (keeps the SPA, its SSE connection and the token). */
async function nav(label: string) {
  // the 体检 link may carry an error-count chip, so match by prefix
  await page.getByRole('navigation', { name: '主导航' }).first().getByRole('link', { name: new RegExp(`^${label}`) }).first().click();
}

async function openProject(name: string) {
  const dir = name === 'proj-gui' ? S.projGui : S.projCli;
  await page.locator(`nav a[href="/projects/${projectId(dir)}"]`).first().click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

/** Diff tabs are named `<file> +N −M`: match the file label exactly. */
const tabName = (t: string | RegExp) => (typeof t === 'string' ? new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`) : t);

/** Project page → column「+ 添加」→ pick → diff → write. Returns the dialog after 完成 is visible. */
async function addViaProjectPage(column: 0 | 1 | 2, pick: RegExp, expectTabs: Array<string | RegExp>, screenshot?: string) {
  await page.getByRole('button', { name: '+ 添加' }).nth(column).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: pick }).check();
  await dialog.getByRole('button', { name: '下一步：预览 diff' }).click();
  for (const t of expectTabs) await expect(dialog.getByRole('tab', { name: tabName(t) })).toBeVisible();
  await expect(dialog.getByText('dryRun=1 · 尚未写入')).toBeVisible();
  if (screenshot) await shot(screenshot, false);
  await dialog.getByRole('button', { name: /写入 \d+ 个文件/ }).click();
  await expect(dialog.getByText(/已写入 \d+ 个文件/)).toBeVisible();
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toHaveCount(0);
}

const toolRow = (switchLabel: string) => page.locator('.hover-row', { has: page.getByRole('switch', { name: switchLabel, exact: true }) });

test('1. overview loads over the real API, SSE connected, no mock badge', async () => {
  await expect(page.getByRole('heading', { name: 'proj-gui', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'proj-cli', exact: true })).toBeVisible();
  await expect(page.getByText('已连接 · 实时同步')).toBeVisible();
  await expect(page.getByText('mock', { exact: true })).toHaveCount(0);
  // token was moved from the URL into sessionStorage
  expect(new URL(page.url()).searchParams.has('token')).toBe(false);
  await shot('real-01-overview.png');
});

test('2. add skill via GUI (clone repo in 工具库, then + 添加 on the project page)', async () => {
  // The add picker only lists library items; a repo not yet under ~/GitHub is brought in with 工具库 →「克隆仓库…」.
  await nav('工具库');
  await page.getByRole('button', { name: '克隆仓库…' }).click();
  await page.getByRole('textbox', { name: '仓库' }).fill(S.repo);
  await page.getByRole('button', { name: '克隆', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // clone runs as a task; task.done → invalidate → library lists the repo's skills
  await expect(page.getByRole('button', { name: /baoyu-comic/ })).toBeVisible({ timeout: 20_000 });
  expect(fs.existsSync(path.join(S.root, 'baoyu-skills', 'skills', 'baoyu-comic', 'SKILL.md'))).toBe(true);

  await openProject('proj-gui');
  await addViaProjectPage(0, /baoyu-comic/, ['tools.json', 'tools.lock.json', '.agents/skills/baoyu-comic'], 'real-02-add-skill-diff.png');

  const lock = readJson(path.join(S.projGui, '.agents', 'tools.lock.json'));
  const tokens = lock.skills['baoyu-comic'].contextTokens as number;
  expect(tokens).toBeGreaterThan(0);
  const row = toolRow('启用 baoyu-comic');
  await expect(row).toBeVisible();
  await expect(row).toContainText(String(tokens));
  expect(fs.readlinkSync(path.join(S.projGui, '.agents', 'skills', 'baoyu-comic'))).toBe(path.join(S.root, 'baoyu-skills', 'skills', 'baoyu-comic'));
});

test('3. add MCP via GUI', async () => {
  await addViaProjectPage(1, /figma/, ['.mcp.json']);
  await expect(toolRow('启用 figma')).toBeVisible();
  const mcp = readJson(path.join(S.projGui, '.mcp.json'));
  expect(mcp.mcpServers.figma.env).toEqual({ FIGMA_API_KEY: '${FIGMA_API_KEY}' });
});

test('4. add plugin via GUI', async () => {
  await addViaProjectPage(2, /security-guidance/, ['.claude/settings.json']);
  await expect(toolRow('启用 security-guidance')).toBeVisible();
  expect(readJson(path.join(S.projGui, '.claude', 'settings.json')).enabledPlugins[PLUGIN]).toBe(true);
});

test('5. parity: the same adds via CLI produce identical files', async () => {
  atm(S.home, ['add', 'skill', S.repo, 'baoyu-comic', '--cwd', S.projCli]);
  atm(S.home, ['add', 'mcp', 'figma', '--cwd', S.projCli]);
  atm(S.home, ['add', 'plugin', PLUGIN, '--cwd', S.projCli]);

  for (const rel of ['.agents/tools.json', '.agents/tools.lock.json', '.mcp.json', '.claude/settings.json', '.gitignore']) {
    expect(read(path.join(S.projCli, rel)), `${rel} differs between GUI and CLI`).toBe(read(path.join(S.projGui, rel)));
  }
  const link = (p: string) => fs.readlinkSync(path.join(p, '.agents', 'skills', 'baoyu-comic'));
  expect(link(S.projCli)).toBe(link(S.projGui));
  expect(fs.readlinkSync(path.join(S.projCli, '.claude', 'skills'))).toBe(fs.readlinkSync(path.join(S.projGui, '.claude', 'skills')));

  // the overview reflects the CLI writes (file watch → SSE) with the same summary for both projects
  await nav('总览');
  for (const name of ['proj-gui', 'proj-cli']) {
    const card = page.locator('article', { has: page.getByRole('heading', { name, exact: true }) });
    for (const chip of ['SKILL 1', 'MCP 1', 'PLUGIN 1']) await expect(card.getByText(chip, { exact: true })).toBeVisible();
  }
  await shot('real-05-parity-overview.png');
});

test('6. live sync: CLI write shows up on the open project page without reload', async () => {
  await openProject('proj-gui');
  await expect(toolRow('启用 linear')).toHaveCount(0);
  const before = page.url();
  atm(S.home, ['add', 'mcp', 'linear', '--cwd', S.projGui]);
  await expect(toolRow('启用 linear')).toBeVisible({ timeout: 5_000 });
  expect(page.url()).toBe(before);
});

test('7. doctor over the real API: broken link → 重建软链 → gone', async () => {
  const skillDir = path.join(S.root, 'baoyu-skills', 'skills', 'baoyu-comic');
  const link = path.join(S.projGui, '.agents', 'skills', 'baoyu-comic');

  // (a) the shared clone loses the skill dir → broken-link in both projects
  fs.renameSync(skillDir, `${skillDir}.bak`);
  try {
    await nav('体检');
    await page.reload();
    const errors = page.getByRole('region', { name: 'error' });
    await expect(errors.getByRole('button', { name: '重建软链' }).first()).toBeVisible();
    await expect(errors).toContainText('proj-gui');
    await shot('real-07-doctor-broken.png');
  } finally {
    fs.renameSync(`${skillDir}.bak`, skillDir);
  }
  await page.reload();
  await expect(page.getByText('没有 error')).toBeVisible();

  // (b) a dangling project link (target restored but link points elsewhere) is rebuilt by the one-click fix
  fs.rmSync(link);
  fs.symlinkSync(path.join(S.root, 'baoyu-skills', 'skills', 'baoyu-comic-moved'), link);
  await page.reload();
  const errors = page.getByRole('region', { name: 'error' });
  await expect(errors.getByRole('button', { name: '重建软链' })).toHaveCount(1);
  await errors.getByRole('button', { name: '重建软链' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('tab', { name: /\.agents\/skills\/baoyu-comic/ })).toBeVisible();
  await dialog.getByRole('button', { name: /写入 \d+ 个文件/ }).click();
  await expect(dialog.getByText(/已写入 \d+ 个文件/)).toBeVisible();
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(page.getByText(/没有其他 error|没有 error/)).toBeVisible();
  expect(fs.readlinkSync(link)).toBe(skillDir);
  await shot('real-07-doctor-fixed.png');
});

test('8. matrix: toggle baoyu-cover on for proj-gui → diff → write', async () => {
  await nav('矩阵');
  // the label flips 启用 ↔ 停用 with the pending state, so match the stable suffix
  const cell = page.getByRole('button', { name: /^(启用|停用) baoyu-cover 于 proj-gui$/ });
  await expect(cell).toHaveAttribute('data-state', 'off');
  await expect(cell).toHaveAccessibleName('启用 baoyu-cover 于 proj-gui');
  await cell.click();
  await expect(cell).toHaveAttribute('data-state', 'pending');
  await expect(page.getByText(/1 处改动待提交/)).toBeVisible();
  await page.getByRole('button', { name: '预览 diff' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('tab', { name: /tools\.json/ }).first()).toBeVisible();
  await expect(dialog.getByRole('tab', { name: /\.agents\/skills\/baoyu-cover/ })).toBeVisible();
  await dialog.getByRole('button', { name: /写入 \d+ 个文件/ }).click();
  await expect(dialog.getByText(/已写入 \d+ 个文件/)).toBeVisible();
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(cell).toHaveAttribute('data-state', 'on');
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  const manifest = readJson(path.join(S.projGui, '.agents', 'tools.json'));
  expect(manifest.skills).toContainEqual({ repo: S.repo, name: 'baoyu-cover' });
  expect(fs.readlinkSync(path.join(S.projGui, '.agents', 'skills', 'baoyu-cover'))).toBe(path.join(S.root, 'baoyu-skills', 'skills', 'baoyu-cover'));
});
