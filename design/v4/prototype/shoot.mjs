import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(dir, '..', '..', '..', 'packages', 'ui', 'package.json'));
const { chromium } = require('@playwright/test');
const url = 'file://' + path.join(dir, 'prototype.html');
mkdirSync(path.join(dir, 'shots'), { recursive: true });

const screens = [
  ['overview', '#/overview'],
  ['project', '#/project'],
  ['library', '#/library'],
  ['matrix', '#/matrix'],
  ['doctor', '#/doctor'],
  ['dialog', '#/library'],
];

const browser = await chromium.launch();
const errors = [];
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme === 'dark' ? 'dark' : 'light' });
  const page = await ctx.newPage();
  page.on('console', m => m.type() === 'error' && errors.push(`${theme}: ${m.text()}`));
  page.on('pageerror', e => errors.push(`${theme}: ${e.message}`));
  await page.goto(url);
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
  for (const [name, hash] of screens) {
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(250);
    if (name === 'dialog') { await page.evaluate(() => window.openDlg()); await page.waitForTimeout(250); }
    await page.screenshot({ path: path.join(dir, 'shots', `${name}-${theme}.png`) });
    if (name === 'dialog') await page.evaluate(() => document.querySelector('[data-close]').click());
  }
  // 密度/主题切换冒烟
  await page.click('#dens');
  await page.click('#theme');
  await page.click('#theme');
  await ctx.close();
}
await browser.close();
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'OK: 12 screenshots, no console errors');
