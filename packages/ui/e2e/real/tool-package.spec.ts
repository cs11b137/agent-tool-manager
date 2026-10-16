import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../server/dist/index.js';
import { zipFixture } from '../../../core/test/zip-fixture.js';

const uiDir = fileURLToPath(new URL('../../dist/', import.meta.url));

test('uploads, previews and installs real packages; conflicts stay blocked on mobile', async ({ page }, testInfo) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atm-package-e2e-')));
  const srv = await startServer({ home, env: {}, uiDir });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const buffer = zipFixture([
    { name: 'skills/package-review/SKILL.md', text: '---\nname: package-review\ndescription: Review\n---\nReview carefully.' },
    { name: 'skills/package-review/scripts/check.sh', text: '#!/bin/sh\nexit 0', mode: 0o100755 },
    { name: 'mcp-registry/package-docs.json', text: '{"url":"https://example.com/mcp"}' },
    { name: 'plugins/package-helper/.claude-plugin/plugin.json', text: '{"name":"package-helper"}' },
  ]);
  try {
    const url = new URL(srv.url); url.pathname = '/library';
    await page.goto(url.toString());
    await page.getByRole('button', { name: '创建共享仓库', exact: true }).click();
    await page.getByRole('button', { name: '创建并保存' }).click();
    await expect(page.getByRole('heading', { name: '工具库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '上传工具包…', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('本地工具文件').setInputFiles({ name: 'tools.zip', mimeType: 'application/zip', buffer });
    await dialog.getByRole('button', { name: '预览工具包' }).click();
    await expect(dialog.getByText('package-review', { exact: true })).toBeVisible();
    await expect(fs.stat(path.join(home, '.agent-tools/skills/package-review'))).rejects.toMatchObject({ code: 'ENOENT' });
    await page.screenshot({ path: testInfo.outputPath('package-preview.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '确认安装' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '全部 3', exact: true })).toBeVisible();
    expect(await fs.readFile(path.join(home, '.agent-tools/skills/package-review/scripts/check.sh'), 'utf8')).toContain('exit 0');
    expect(JSON.parse(await fs.readFile(path.join(home, '.agent-tools/mcp-registry/package-docs.json'), 'utf8')).name).toBe('package-docs');
    await page.reload();
    await expect(page.getByRole('tab', { name: '全部 3', exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '上传工具包…', exact: true }).click();
    await dialog.getByLabel('本地工具文件').setInputFiles({ name: 'tools.zip', mimeType: 'application/zip', buffer });
    await dialog.getByRole('button', { name: '预览工具包' }).click();
    await expect(dialog.getByText('已存在，无法覆盖')).toHaveCount(3);
    await expect(dialog.getByRole('button', { name: '确认安装' })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('package-conflict-mobile.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Download and install…', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Download from a third party' })).toBeVisible();
    await dialog.getByLabel('Tool URL or MCP package').fill('http://example.com/tools.zip');
    await dialog.getByRole('button', { name: 'Preview package' }).click();
    await expect(dialog.getByText(/HTTPS 默认端口/)).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await srv.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('native file upload and search results install selected tools through the real server', async ({ page }, testInfo) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atm-native-e2e-')));
  const srv = await startServer({ home, env: {}, uiDir });
  try {
    const url = new URL(srv.url); url.pathname = '/library';
    await page.goto(url.toString());
    await page.getByRole('button', { name: '创建共享仓库', exact: true }).click();
    await page.getByRole('button', { name: '创建并保存' }).click();
    await page.getByRole('button', { name: '上传工具包…', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('本地工具文件').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: raw-skill\ndescription: Native markdown\n---\nReview.') });
    await dialog.getByRole('button', { name: '预览工具包' }).click();
    await expect(dialog.getByRole('checkbox', { name: 'raw-skill' })).toBeChecked();
    await dialog.getByRole('button', { name: '确认安装' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await fs.readFile(path.join(home, '.agent-tools/skills/raw-skill/SKILL.md'), 'utf8')).toContain('Native markdown');

    const directory = path.join(home, 'catalog-fixture');
    await fs.mkdir(path.join(directory, 'skills/review/assets'), { recursive: true });
    await fs.mkdir(path.join(directory, 'mcp-registry'), { recursive: true });
    await fs.writeFile(path.join(directory, 'skills/review/SKILL.md'), '---\nname: catalog-review\ndescription: Catalog\n---\nReview.');
    await fs.writeFile(path.join(directory, 'skills/review/assets/template.txt'), 'preserved resource');
    await fs.writeFile(path.join(directory, 'mcp-registry/unselected.json'), '{"name":"unselected","url":"https://example.com/mcp"}');
    await page.route('**/api/external-tools?*', (route) => route.fulfill({ json: { items: [{ id: 'fixture', name: 'Catalog Review', description: 'Native directory from test catalog', provider: 'Test catalog', url: 'https://github.com/example/tools', source: { type: 'directory', path: directory } }], warnings: [] } }));
    await page.getByRole('button', { name: '搜索安装…', exact: true }).click();
    await dialog.getByLabel('搜索第三方工具').fill('review');
    await dialog.getByRole('button', { name: '搜索工具', exact: true }).click();
    await expect(dialog.getByText('Catalog Review', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '预览安装' }).click();
    await dialog.getByRole('checkbox', { name: 'unselected', exact: true }).uncheck();
    await page.screenshot({ path: testInfo.outputPath('native-selection.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '确认安装' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await fs.readFile(path.join(home, '.agent-tools/skills/catalog-review/assets/template.txt'), 'utf8')).toBe('preserved resource');
    await expect(fs.stat(path.join(home, '.agent-tools/mcp-registry/unselected.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(page.getByRole('tab', { name: '全部 2', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下载安装…', exact: true }).click();
    await dialog.getByRole('tab', { name: 'GitHub', exact: true }).click();
    await expect(dialog.getByLabel('GitHub 仓库地址')).toBeVisible();
    await expect(dialog.getByLabel('仓库内路径（可选）')).toBeVisible();
  } finally { await srv.close(); await fs.rm(home, { recursive: true, force: true }); }
});
