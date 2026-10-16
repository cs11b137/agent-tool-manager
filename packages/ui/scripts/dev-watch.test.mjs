import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchDev } from './dev-watch.mjs';

test('source changes restart the process, reload code and preserve the session token', { timeout: 15000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atm-dev-watch-'));
  const source = path.join(dir, 'src');
  await fs.mkdir(source);
  const script = path.join(source, 'server.mjs'), result = path.join(dir, 'result.json');
  const code = (version) => `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({version:${version},pid:process.pid,token:process.env.ATM_DEV_TOKEN})); setInterval(()=>{},1000);`;
  await fs.writeFile(script, code(1));
  const runner = watchDev({ paths: [source], command: process.execPath, args: [script], stdio: 'ignore' });
  async function ready(version) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { const data = JSON.parse(await fs.readFile(result, 'utf8')); if (data.version === version) return data; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Development process did not load revision ' + version);
  }
  let current;
  try {
    const first = await ready(1);
    await fs.writeFile(script, code(2));
    current = await ready(2);
    assert.notEqual(current.pid, first.pid);
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(current.token, first.token);
    // A failed startup must not disable the watcher: the next source correction recovers.
    await fs.writeFile(script, 'process.exit(1);');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fs.writeFile(script, code(3));
    current = await ready(3);
    assert.equal(current.token, first.token);
  } finally {
    await runner.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.throws(() => process.kill(current.pid, 0), { code: 'ESRCH' });
});
