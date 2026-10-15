import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../server/dist/index.js';

const uiDir = fileURLToPath(new URL('../../dist/', import.meta.url));

test('Chinese and English work across onboarding, navigation, dialogs, reloads and mobile', async ({ page }, testInfo) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atm-localization-')));
  const srv = await startServer({ home, env: {}, uiDir });
  try {
    await page.goto(srv.url);
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create your shared repository' })).toBeVisible();
    await page.getByRole('button', { name: 'Create repository', exact: true }).click();
    await page.getByRole('button', { name: 'Create and save' }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    for (const [label, heading] of [['Tool library', 'Tool library'], ['Tool assignments', 'Tool assignments'], ['Health check', 'Health check'], ['Local tools', 'Local tools']] as const) {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: label, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      const content = await page.locator('main').innerText();
      expect(content, label).not.toMatch(/[\u3400-\u9fff]/);
    }
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Local tools' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Shared repository directory').fill('/tmp/工具库');
    await dialog.getByRole('button', { name: '中文', exact: true }).click();
    await expect(dialog.getByLabel('共享仓库目录')).toHaveValue('/tmp/工具库');
    await expect(dialog.getByRole('heading', { name: '更新仓库' })).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('link', { name: '工具库', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('sidebar-zh.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '打开导航' }).click();
    await expect(dialog.getByRole('link', { name: '健康检查', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'English', exact: true }).click();
    await expect(dialog.getByRole('link', { name: 'Health check', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('sidebar-mobile-en.png'), animations: 'disabled' });
    await dialog.getByRole('link', { name: 'Tool assignments', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Tool assignments' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const cfg = JSON.parse(await fs.readFile(path.join(home, '.config/atm/config.json'), 'utf8'));
    expect(cfg.projects ?? []).toEqual([]);
    expect(cfg.root).toBe('~/.agent-tools');
  } finally {
    await srv.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});
