import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtmError, estimateTokens, parseFrontmatter, projectId, unifiedDiff, validateLock, validateManifest, validateMcpDef, serializeLock, serializeManifest } from '../src/index.js';
import { scanSkills } from '../src/skills/discover.js';
import { pickSkill } from '../src/skills/resolver.js';
import { parseRepo, normalizeRemote, repoSlugFromRemote } from '../src/skills/repo.js';
import { isPlaintextSecret, scanServers } from '../src/mcp/secrets.js';
import { hashMcpDef } from '../src/mcp/registry.js';
import { mkTmp, skillMd, writeFiles } from './helpers.js';

describe('frontmatter', () => {
  it('parses key: value, quoted strings and continuation lines', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'name: baoyu-comic',
        'description: "Make comics: panels, \\"bubbles\\""',
        "title: 'it''s fine'",
        'long: >',
        '  first line',
        '  second line',
        'plain: value # comment',
        '---',
        'body',
      ].join('\n'),
    );
    expect(fm).toEqual({
      name: 'baoyu-comic',
      description: 'Make comics: panels, "bubbles"',
      title: "it's fine",
      long: 'first line second line',
      plain: 'value',
    });
  });

  it('returns {} without frontmatter and handles CRLF', () => {
    expect(parseFrontmatter('# hello\nname: x')).toEqual({});
    expect(parseFrontmatter('---\r\nname: crlf\r\n---\r\n')).toEqual({ name: 'crlf' });
  });
});

describe('skill discovery', () => {
  it('finds skills across the three layouts and skips node_modules/.git', async () => {
    const repo = await mkTmp();
    await writeFiles(repo, {
      'alpha/SKILL.md': skillMd('alpha', 'top level'),
      'skills/beta/SKILL.md': skillMd('beta', 'under skills/'),
      'skills/design/gamma/SKILL.md': skillMd('gamma', 'categorised'),
      'skills/nameless/SKILL.md': skillMd(null, 'no name in frontmatter'),
      'node_modules/pkg/SKILL.md': skillMd('ignored', 'x'),
      '.git/SKILL.md': skillMd('ignored2', 'x'),
    });
    const skills = await scanSkills(repo);
    expect(skills.map((s) => [s.name, s.path]).sort()).toEqual([
      ['alpha', 'alpha'],
      ['beta', path.join('skills', 'beta')],
      ['gamma', path.join('skills', 'design', 'gamma')],
      ['nameless', path.join('skills', 'nameless')],
    ]);
    expect(pickSkill(skills, { repo: 'o/r', name: 'gamma' }).path).toBe(path.join('skills', 'design', 'gamma'));
    // 兜底：frontmatter 没有 name 时按目录名
    expect(pickSkill(skills, { repo: 'o/r', name: 'nameless' }).declaredName).toBe(false);
  });

  it('falls back to the directory name when frontmatter name differs', async () => {
    const repo = await mkTmp();
    await writeFiles(repo, { 'skills/comic/SKILL.md': skillMd('Baoyu Comic', 'x') });
    const skills = await scanSkills(repo);
    expect(pickSkill(skills, { repo: 'o/r', name: 'comic' }).path).toBe(path.join('skills', 'comic'));
    // frontmatter 名带空格，不能作为 `.agents/skills/<name>`：NOT_FOUND，并建议目录名
    const err = (() => {
      try {
        pickSkill(skills, { repo: 'o/r', name: 'Baoyu Comic' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({ code: 'NOT_FOUND', candidates: ['comic'] });
  });

  it('throws AMBIGUOUS with candidate paths and NOT_FOUND with names', async () => {
    const repo = await mkTmp();
    await writeFiles(repo, {
      'a/dup/SKILL.md': skillMd('dup', 'one'),
      'b/dup/SKILL.md': skillMd('dup', 'two'),
      'c/SKILL.md': skillMd('other', 'x'),
    });
    const skills = await scanSkills(repo);
    try {
      pickSkill(skills, { repo: 'o/r', name: 'dup' });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AtmError);
      expect((e as AtmError).code).toBe('AMBIGUOUS');
      expect((e as AtmError).candidates).toEqual([path.join('a', 'dup'), path.join('b', 'dup')]);
      expect((e as AtmError).nextCommand).toBeTruthy();
    }
    try {
      pickSkill(skills, { repo: 'o/r', name: 'missing' });
      expect.fail('should throw');
    } catch (e) {
      expect((e as AtmError).code).toBe('NOT_FOUND');
      expect((e as AtmError).candidates).toEqual(['dup', 'other']);
    }
  });
});

describe('repo specs', () => {
  it('parses owner/repo, URLs and local paths', () => {
    expect(parseRepo('jimliu/baoyu-skills', '/h')).toMatchObject({ url: 'https://github.com/jimliu/baoyu-skills.git', name: 'baoyu-skills', owner: 'jimliu' });
    expect(parseRepo('git@github.com:jimliu/baoyu-skills.git', '/h')).toMatchObject({ name: 'baoyu-skills', owner: 'jimliu' });
    expect(parseRepo('https://gitlab.com/a/b/c.git', '/h')).toMatchObject({ name: 'c', owner: 'b' });
    expect(parseRepo('/tmp/remotes/skills.git', '/h')).toMatchObject({ url: '/tmp/remotes/skills.git', name: 'skills' });
    expect(parseRepo('file:///tmp/x/skills.git', '/h')).toMatchObject({ url: 'file:///tmp/x/skills.git', name: 'skills' });
    expect(normalizeRemote('git@github.com:A/B.git', '/h')).toBe(normalizeRemote('https://github.com/a/b', '/h'));
    expect(repoSlugFromRemote('https://github.com/jimliu/baoyu-skills.git')).toBe('jimliu/baoyu-skills');
  });
});

describe('manifest & lock', () => {
  it('validates and normalises tools.json', () => {
    const m = validateManifest({ agents: ['claude-code'], skills: [{ repo: 'a/b', name: 'x' }], mcp: ['figma', { name: 'pw', agents: ['cursor'] }] });
    expect(m).toEqual({ agents: ['claude-code'], skills: [{ repo: 'a/b', name: 'x' }], mcp: ['figma', { name: 'pw', agents: ['cursor'] }], plugins: [] });
    expect(validateManifest(JSON.parse(serializeManifest(m)))).toEqual(m);
    const bad = (raw: unknown) => {
      try {
        validateManifest(raw);
        return null;
      } catch (e) {
        return (e as AtmError).code;
      }
    };
    expect(bad({ agents: ['vim'] })).toBe('INVALID_MANIFEST');
    expect(bad({ agents: [], skills: [{ repo: 'a/b' }] })).toBe('INVALID_MANIFEST');
    expect(bad({ agents: [], mcp: ['a', 'a'] })).toBe('INVALID_MANIFEST');
    expect(bad([])).toBe('INVALID_MANIFEST');
  });

  it('round-trips the lock file with sorted keys', () => {
    const lock = validateLock({
      version: 1,
      skills: { z: { repo: 'a/b', path: 'z', commit: 'c1', contextTokens: 3 }, a: { repo: 'a/b', path: 'a', commit: 'c1', contextTokens: 2, rev: 'v1', worktree: '/w' } },
      mcp: { figma: { hash: 'sha256:x', contextTokens: 10 } },
      managed: { 'claude-code': { mcp: ['figma'], plugins: [] }, cursor: { mcp: [], plugins: [] } },
    });
    const text = serializeLock(lock);
    expect(Object.keys(JSON.parse(text).skills)).toEqual(['a', 'z']);
    expect(JSON.parse(text).managed).toEqual({ 'claude-code': { mcp: ['figma'], plugins: [] } });
    expect(validateLock(JSON.parse(text))).toEqual({ ...lock, managed: { 'claude-code': { mcp: ['figma'], plugins: [] } } });
    expect(() => validateLock({ version: 2 })).toThrow(AtmError);
  });
});

describe('mcp definitions', () => {
  it('accepts stdio/http with ${VAR} references', () => {
    expect(validateMcpDef({ name: 'figma', transport: 'stdio', command: 'npx', args: ['-y', 'figma'], env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' } })).toMatchObject({ transport: 'stdio' });
    expect(validateMcpDef({ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } })).toMatchObject({ transport: 'http' });
    // 缺 transport 时按字段推断，缺 name 时用文件名
    expect(validateMcpDef({ url: 'https://x.dev/mcp' }, 'x.json', 'x')).toMatchObject({ name: 'x', transport: 'http' });
  });

  it('rejects literal env/header values and bad shapes', () => {
    const code = (raw: unknown) => {
      try {
        validateMcpDef(raw);
        return null;
      } catch (e) {
        return (e as AtmError).code;
      }
    };
    expect(code({ name: 'a', transport: 'stdio', command: 'x', env: { KEY: 'literal' } })).toBe('INVALID_MCP_DEF');
    expect(code({ name: 'a', transport: 'stdio', command: 'x', env: { KEY: 'pre-${KEY}' } })).toBe('INVALID_MCP_DEF');
    expect(code({ name: 'a', transport: 'http', url: 'https://x', headers: { Authorization: 'Bearer abc' } })).toBe('INVALID_MCP_DEF');
    expect(code({ name: 'a', transport: 'http' })).toBe('INVALID_MCP_DEF');
    expect(code({ name: 'a', transport: 'stdio' })).toBe('INVALID_MCP_DEF');
    expect(code({ name: 'a', transport: 'ws', command: 'x' })).toBe('INVALID_MCP_DEF');
    expect(code({ name: 'bad name', transport: 'stdio', command: 'x' })).toBe('INVALID_MCP_DEF');
  });

  it('hashes definitions canonically', () => {
    const a = validateMcpDef({ name: 'a', transport: 'stdio', command: 'x', args: ['1'] });
    const b = validateMcpDef({ args: ['1'], command: 'x', transport: 'stdio', name: 'a' });
    expect(hashMcpDef(a)).toBe(hashMcpDef(b));
    expect(hashMcpDef(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('secret scan', () => {
  it('flags literal values under secret-looking keys only', () => {
    expect(isPlaintextSecret('API_KEY', 'sk-123')).toBe(true);
    expect(isPlaintextSecret('API_KEY', '${API_KEY}')).toBe(false);
    expect(isPlaintextSecret('API_KEY', '${env:API_KEY}')).toBe(false);
    expect(isPlaintextSecret('API_KEY', '$API_KEY')).toBe(false);
    expect(isPlaintextSecret('NODE_ENV', 'production')).toBe(false);
    expect(scanServers({ a: { env: { GITHUB_TOKEN: 'ghp_x' } }, b: { http_headers: { Authorization: 'Bearer x' } } }).map((h) => h.server)).toEqual(['a', 'b']);
  });
});

describe('estimateTokens', () => {
  it('counts ASCII ÷ 4 and CJK ÷ 1.5', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('中文测试')).toBe(3); // 4 / 1.5 = 2.67
    expect(estimateTokens('漫画生成')).toBe(3);
    expect(estimateTokens('abcd中文')).toBe(Math.round(1 + 2 / 1.5));
    expect(estimateTokens('日本語のテキスト')).toBe(Math.round(8 / 1.5));
  });
});

describe('unified diff', () => {
  it('produces hunks with context and counts', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n') + '\n';
    const d = unifiedDiff('x.txt', before, after);
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
    expect(d.diff).toBe(
      ['--- a/x.txt', '+++ b/x.txt', '@@ -1,10 +1,11 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', ' h', ' i', ' j', '+k', ''].join('\n'),
    );
    expect(unifiedDiff('n', null, 'x\n').diff).toBe('--- /dev/null\n+++ b/n\n@@ -0,0 +1,1 @@\n+x\n');
    expect(unifiedDiff('n', 'same\n', 'same\n')).toEqual({ diff: '', additions: 0, deletions: 0 });
  });

  it('splits distant changes into separate hunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const after = [...lines];
    after[2] = 'X';
    after[25] = 'Y';
    const d = unifiedDiff('f', lines.join('\n') + '\n', after.join('\n') + '\n');
    expect(d.diff.match(/^@@/gm)).toHaveLength(2);
  });
});

describe('projectId', () => {
  it('is sha1(abs path)[0..12]', () => {
    expect(projectId('/a/b')).toMatch(/^[0-9a-f]{12}$/);
    expect(projectId('/a/b')).toBe(projectId('/a/b/'));
  });
});
