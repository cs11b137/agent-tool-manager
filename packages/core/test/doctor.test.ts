import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRemote, setup, skillMd, write, writeInstalledPlugins } from './helpers.js';

describe('doctor', () => {
  it('reports broken-link, missing-link, plaintext-secret, skill-shadowed, mcp-dup-plugin, plugin-global-only, context-total; fix rebuilds links', async () => {
    const env = await setup();
    const { atm, home, registry } = env;
    const remote = await makeRemote(env.base, 'skills', {
      'skills/comic/SKILL.md': skillMd('comic', 'Comic strips'),
      'skills/cover/SKILL.md': skillMd('cover', 'Covers'),
    });
    await write(path.join(registry, 'figma.json'), JSON.stringify({ name: 'figma', transport: 'stdio', command: 'npx', env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' } }));
    await writeInstalledPlugins(home, {
      'figma@claude-plugins-official': { files: { '.mcp.json': JSON.stringify({ mcpServers: { figma: { command: 'x' } } }) } },
      'security-guidance@claude-plugins-official': { files: { 'skills/s/SKILL.md': skillMd('sec', 'Security checklist for code review') } },
    });
    await write(
      path.join(home, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { 'figma@claude-plugins-official': true, 'security-guidance@claude-plugins-official': true } }),
    );
    await write(path.join(home, '.claude/skills/comic/SKILL.md'), skillMd('comic', 'global copy'));

    const dir = await env.project('app');
    await atm.init(dir);
    await atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'comic' });
    await atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'cover' });
    await atm.add(dir, { kind: 'mcp', name: 'figma' });
    await atm.add(dir, { kind: 'plugin', name: 'security-guidance@claude-plugins-official' });
    // 手写一个带明文密钥的条目
    const mcpPath = path.join(dir, '.mcp.json');
    const mcp = JSON.parse(await fs.readFile(mcpPath, 'utf8'));
    mcp.mcpServers.github = { command: 'gh-mcp', env: { GITHUB_TOKEN: 'ghp_literal' } };
    await fs.writeFile(mcpPath, JSON.stringify(mcp, null, 2));
    // 断链 + 缺链
    await fs.rm(path.join(dir, '.agents/skills/comic'));
    await fs.symlink(path.join(env.base, 'gone'), path.join(dir, '.agents/skills/comic'));
    await fs.rm(path.join(dir, '.agents/skills/cover'));

    const report = await atm.doctor(dir);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['broken-link', 'missing-link', 'plaintext-secret', 'skill-shadowed', 'mcp-dup-plugin', 'plugin-global-only', 'context-total']),
    );
    const broken = report.issues.find((i) => i.code === 'broken-link')!;
    expect(broken).toMatchObject({ level: 'error', fixable: true, name: 'comic', kind: 'skill' });
    expect(broken.id).toBe(`broken-link:${atm.projectId(dir)}:skill:comic`);
    expect(report.issues.find((i) => i.code === 'plaintext-secret')).toMatchObject({ level: 'error', fixable: false, name: 'github@.mcp.json' });
    expect(report.issues.find((i) => i.code === 'mcp-dup-plugin')).toMatchObject({ level: 'warn', name: 'figma' });
    expect(report.issues.find((i) => i.code === 'skill-shadowed')).toMatchObject({ level: 'warn', name: 'comic' });
    expect(report.issues.find((i) => i.code === 'plugin-global-only')).toMatchObject({ level: 'info', name: 'security-guidance@claude-plugins-official' });
    const total = report.issues.find((i) => i.code === 'context-total')!;
    expect(total.title).toMatch(/Context ≈ \d+ tokens \(\+1 unmeasured\)/);
    expect(report.counts.error).toBe(3);
    expect(report.projects[0]!.context.unmeasured).toBe(1);
    expect(report.measured).toBe(false);

    // list 包含同样的 issues
    expect((await atm.list(dir)).issues.map((i) => i.id)).toEqual(report.issues.map((i) => i.id));

    // fix：只处理 fixable
    const fixIds = report.issues.filter((i) => i.fixable).map((i) => i.id);
    const dry = await atm.fix([...fixIds, 'plaintext-secret:x'], { dryRun: true });
    expect(dry.applied).toBe(false);
    expect(dry.files.map((f) => f.relPath).sort()).toEqual(['.agents/skills/comic', '.agents/skills/cover']);
    const fixed = await atm.fix(fixIds);
    expect(fixed.files).toEqual(dry.files);
    const after = await atm.doctor('all');
    expect(after.issues.filter((i) => i.fixable)).toEqual([]);
  });

  it('plugin-not-installed, rev-mismatch, repo-dirty and project-missing', async () => {
    const env = await setup();
    const { atm, home } = env;
    const remote = await makeRemote(env.base, 'skills', { 'a/SKILL.md': skillMd('a', 'x') });
    const dir = await env.project('p1');
    await atm.init(dir);
    await atm.add(dir, { kind: 'skill', repo: remote.bare, name: 'a' });
    // 清单里直接写一个未安装的插件
    const manifestPath = path.join(dir, '.agents/tools.json');
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    m.plugins.push('ghost@x');
    await fs.writeFile(manifestPath, JSON.stringify(m));
    // 仓库前进 + 脏
    const clone = path.join(env.root, 'skills');
    await fs.writeFile(path.join(clone, 'a/SKILL.md'), skillMd('a', 'edited locally'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['commit', '-qam', 'local'], { cwd: clone });
    await fs.writeFile(path.join(clone, 'dirty.txt'), 'x');

    const missing = await env.project('gone');
    await atm.registerProject(missing);
    await fs.rm(missing, { recursive: true });

    const r = await atm.doctor('all');
    const by = (code: string) => r.issues.filter((i) => i.code === code);
    expect(by('plugin-not-installed')[0]).toMatchObject({ level: 'error', nextCommand: '/plugin install ghost@x' });
    expect(by('rev-mismatch')[0]).toMatchObject({ level: 'warn', name: 'a' });
    expect(by('repo-dirty')[0]).toMatchObject({ level: 'info' });
    expect(by('project-missing')[0]).toMatchObject({ level: 'error', projectId: atm.projectId(missing) });
    const projects = await atm.projects();
    expect(projects.find((p) => p.path === missing)).toMatchObject({ exists: false, initialized: false, counts: { skills: 0, mcp: 0, plugins: 0 } });
    void home;
  });

  it('flags plaintext secrets in registry definitions (doctor all)', async () => {
    const env = await setup();
    await write(path.join(env.registry, 'leaky.json'), JSON.stringify({ name: 'leaky', transport: 'stdio', command: 'x', env: { API_KEY: 'sk-live' } }));
    const r = await env.atm.doctor('all');
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'plaintext-secret', name: 'leaky' }));
  });
});
