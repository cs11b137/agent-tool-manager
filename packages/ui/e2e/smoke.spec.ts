import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'screenshots');
mkdirSync(OUT, { recursive: true });

/** id of web-app in the mock seed (src/api/mock-data.ts IDS.webApp) */
const WEB_APP = 'a1f3c9e20b7d';

const ROUTES: Array<{ file: string; path: string; ready: (p: Page) => Promise<void> }> = [
  { file: '01-overview.png', path: '/', ready: (p) => expect(p.getByRole('heading', { name: 'web-app' })).toBeVisible() },
  { file: '02-project-detail.png', path: `/projects/${WEB_APP}`, ready: (p) => expect(p.getByRole('heading', { name: 'Skills' })).toBeVisible() },
  { file: '03-library.png', path: '/library', ready: (p) => expect(p.getByRole('button', { name: '预览改动' })).toBeVisible() },
  { file: '04-matrix.png', path: '/matrix', ready: (p) => expect(p.getByText('上下文合计')).toBeVisible() },
  { file: '05-doctor.png', path: '/doctor', ready: (p) => expect(p.getByRole('button', { name: '重建软链' })).toBeVisible() },
  { file: '06-global.png', path: '/global', ready: (p) => expect(p.getByRole('button', { name: '扫描本机工具' })).toBeVisible() },
];

async function settle(page: Page) {
  // let entrance animations (rise, ≤ 0.98s) finish
  await page.waitForTimeout(1200);
}

for (const r of ROUTES) {
  test(`screenshot ${r.path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(r.path);
    await r.ready(page);
    await settle(page);
    await page.screenshot({ path: join(OUT, r.file), fullPage: true, animations: 'disabled' });
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('add-tool diff modal (prototype 03)', async ({ page }) => {
  await page.goto('/library');
  await page.getByRole('button', { name: '预览改动' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('tab', { name: /\.mcp\.json/ })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: join(OUT, '07-add-diff-modal.png'), fullPage: false, animations: 'disabled' });
  await page.getByRole('button', { name: /写入 \d+ 个文件/ }).click();
  await expect(page.getByText(/已写入 \d+ 个文件/)).toBeVisible();
});

test('dark theme overview', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('heading', { name: 'web-app' })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: join(OUT, '08-overview-dark.png'), fullPage: true, animations: 'disabled' });
  await ctx.close();
});

test.describe('write flows against the mock', () => {
  test.beforeEach(({ page }) => {
    page.on('pageerror', (e) => {
      throw e;
    });
  });

  test('project detail: toggle off → pending bar → diff → write', async ({ page }) => {
    await page.goto(`/projects/${WEB_APP}`);
    await page.getByRole('switch', { name: '启用 baoyu-cover' }).click();
    await expect(page.getByText('1 项改动待提交')).toBeVisible();
    await page.getByRole('button', { name: '预览并应用' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: /\.agents\/skills\/baoyu-cover/ })).toBeVisible();
    await dialog.getByRole('button', { name: /写入 \d+ 个文件/ }).click();
    await expect(dialog.getByText(/已写入/)).toBeVisible();
    await dialog.getByRole('button', { name: '完成' }).click();
    await expect(page.getByRole('switch', { name: '启用 baoyu-cover' })).toHaveCount(0);
    await expect(page.getByText('项改动待提交')).toHaveCount(0);
  });

  test('project detail: + 添加 opens step 1 picker, then preview', async ({ page }) => {
    await page.goto(`/projects/${WEB_APP}`);
    await page.getByRole('button', { name: '+ 添加' }).nth(1).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio').first().check();
    await dialog.getByRole('button', { name: '下一步：预览改动' }).click();
    await expect(dialog.getByRole('tab', { name: /tools\.json/ }).first()).toBeVisible();
    await dialog.getByRole('button', { name: /写入 \d+ 个文件/ }).click();
    await expect(dialog.getByText(/已写入/)).toBeVisible();
  });

  test('project detail: 查看生成的配置 + agents change', async ({ page }) => {
    await page.goto(`/projects/${WEB_APP}`);
    await page.getByRole('button', { name: '查看生成的配置' }).click();
    await expect(page.getByRole('dialog').getByRole('tab', { name: /\.mcp\.json/ })).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();
    // controlled checkbox: it only flips after the diff is confirmed
    await page.getByRole('checkbox', { name: 'Codex' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: /\.codex\/config\.toml/ })).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
  });

  test('doctor: one-click fix rebuilds the broken link', async ({ page }) => {
    await page.goto('/doctor');
    await page.getByRole('button', { name: '自动修复（1）' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: /baoyu-comic/ })).toBeVisible();
    await dialog.getByRole('button', { name: '写入 1 个文件' }).click();
    await dialog.getByRole('button', { name: '完成' }).click();
    await expect(page.getByText('未发现其他错误', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: '暂无可自动修复项' })).toBeDisabled();
  });

  test('global: migrate wizard (pick projects → diff → confirm)', async ({ page }) => {
    await page.goto('/global');
    await page.getByRole('button', { name: '扫描本机工具' }).click();
    await page.getByRole('button', { name: '移到项目级…' }).nth(1).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox', { name: /web-app/ })).toBeChecked();
    await dialog.getByRole('button', { name: '下一步：预览改动' }).click();
    await expect(dialog.getByRole('tab', { name: /~\/\.claude\/settings\.json/ })).toBeVisible();
    await dialog.getByRole('button', { name: /写入 \d+ 个文件/ }).click();
    await dialog.getByRole('button', { name: '完成' }).click();
    await expect(page.getByText('没有本机工具启用的插件。')).toBeVisible();
  });

  test('narrow viewport collapses the sidebar into a top nav', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'web-app' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(OUT, '09-overview-mobile.png'), fullPage: false, animations: 'disabled' });
    await ctx.close();
  });
});
