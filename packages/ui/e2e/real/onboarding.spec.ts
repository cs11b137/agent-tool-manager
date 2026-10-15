import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../server/dist/index.js';

const uiDir = fileURLToPath(new URL('../../dist/', import.meta.url));

test('fresh install stays empty until a tool is explicitly added', async ({ page }, testInfo) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atm-onboarding-')));
  const installPath = path.join(home, '.claude/plugins/cache/native');
  await fs.mkdir(installPath, { recursive: true });
  await fs.writeFile(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'native@market': [{ scope: 'user', installPath, version: '1.0.0' }] } }));
  const srv = await startServer({ home, env: {}, uiDir });
  const globalRequests: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/global') globalRequests.push(request.url()); });
  try {
    const url = new URL(srv.url);
    url.pathname = '/library';
    await page.goto(url.toString());
    await expect(page.getByRole('heading', { name: '先创建你的共享仓库' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByText('native@market')).toHaveCount(0);
    await expect(fs.stat(path.join(home, '.agent-tools'))).rejects.toMatchObject({ code: 'ENOENT' });

    await page.getByRole('button', { name: '创建共享仓库', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '创建并保存' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await fs.stat(path.join(home, '.agent-tools/mcp-registry'))).isDirectory()).toBe(true);
    await expect(page.getByText('还没有添加工具')).toBeVisible();

    for (const kind of ['skill', 'plugin']) {
      await page.getByRole('button', { name: '新建工具…' }).click();
      await dialog.getByLabel('工具类型').selectOption(kind);
      await dialog.getByLabel('名称', { exact: true }).fill(`my-${kind}`);
      await dialog.getByLabel('描述', { exact: true }).fill('Created in the shared repository');
      await dialog.getByLabel('工具指令', { exact: true }).fill('# Instructions\nReview the project carefully.');
      await dialog.getByRole('button', { name: '创建工具', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    await page.getByRole('button', { name: '新建 MCP 定义…' }).click();
    await dialog.getByLabel('名称', { exact: true }).fill('chosen');
    await dialog.getByRole('tab', { name: 'http', exact: true }).click();
    await dialog.getByLabel('url', { exact: true }).fill('https://example.invalid/mcp');
    await dialog.getByRole('button', { name: '保存定义' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '全部 3', exact: true })).toBeVisible();
    await expect(page.getByText('还没有添加工具')).toHaveCount(0);
    expect(JSON.parse(await fs.readFile(path.join(home, '.agent-tools/mcp-registry/chosen.json'), 'utf8')).name).toBe('chosen');

    const project = path.join(home, 'my-project');
    await fs.mkdir(project);
    await page.getByRole('button', { name: '添加项目…' }).click();
    await dialog.getByLabel('项目目录').fill(project);
    await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'my-project', exact: true })).toBeVisible();
    for (const [index, name] of ['my-skill', 'chosen', 'my-plugin'].entries()) {
      await page.getByRole('button', { name: '+ 添加', exact: true }).nth(index).click();
      await dialog.getByRole('radio', { name: new RegExp(name) }).check();
      await dialog.getByRole('button', { name: '下一步：预览改动' }).click();
      await dialog.getByRole('button', { name: /写入 \d+ 个文件/ }).click();
      await expect(dialog.getByText(/已写入 \d+ 个文件/)).toBeVisible();
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(project, '.agents/tools.json'), 'utf8'));
    expect(manifest.skills).toContainEqual({ repo: 'atm:shared', name: 'my-skill' });
    expect(manifest.mcp).toContain('chosen');
    expect(manifest.plugins).toContain('my-plugin@atm-shared');
    expect(await fs.realpath(path.join(project, '.agents/skills/my-skill'))).toBe(path.join(home, '.agent-tools/skills/my-skill'));
    const settings = JSON.parse(await fs.readFile(path.join(project, '.claude/settings.json'), 'utf8'));
    expect(settings.extraKnownMarketplaces['atm-shared'].source.path).toBe(path.join(home, '.agent-tools'));
    await page.getByRole('navigation', { name: '主导航' }).first().getByRole('link', { name: '工具库', exact: true }).click();
    const root = path.join(home, '.agent-tools');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(root, 'config', 'user.name', 'Test User');
    git(root, 'config', 'user.email', 'test@example.invalid');
    const remote = path.join(home, 'remote.git');
    await fs.mkdir(remote);
    git(remote, 'init', '--bare', '-b', 'main');
    await page.getByLabel('远程仓库地址').fill(remote);
    await page.getByRole('button', { name: '保存远程地址', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存远程地址', exact: true })).toBeEnabled();
    await page.getByLabel('提交说明').fill('Create my tools');
    await page.getByRole('button', { name: '提交改动', exact: true }).click();
    await expect(page.getByRole('button', { name: '推送', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '推送', exact: true }).click();
    await expect(page.getByText('推送完成', { exact: true })).toBeVisible();
    expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'));
    await page.screenshot({ path: testInfo.outputPath('shared-repository-workflow.png'), fullPage: true });

    await page.getByRole('navigation', { name: '主导航' }).first().getByRole('link', { name: '本机工具', exact: true }).click();
    await expect(page.getByRole('button', { name: '扫描本机工具' })).toBeVisible();
    expect(globalRequests).toEqual([]);
  } finally {
    await page.close();
    await srv.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});
