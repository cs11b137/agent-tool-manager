import fs from 'node:fs/promises';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { atomicWrite } from '../fs/atomic.js';
import { findFiles, readJson, readText } from '../fs/walk.js';
import { git } from '../git.js';
import { skillTokens } from '../tokens.js';
import { parseFrontmatter } from './frontmatter.js';

export interface DiscoveredSkill {
  /** frontmatter name，缺省为目录名 */
  name: string;
  /** frontmatter 是否声明了 name */
  declaredName: boolean;
  description?: string;
  /** 相对仓库根目录的路径（SKILL.md 所在目录） */
  path: string;
  contextTokens: number;
}

export async function readSkillMeta(skillDir: string): Promise<{ name?: string; description?: string } | null> {
  const text = await readText(path.join(skillDir, 'SKILL.md'));
  if (text === null) return null;
  const fm = parseFrontmatter(text);
  const out: { name?: string; description?: string } = {};
  if (fm.name) out.name = fm.name;
  if (fm.description) out.description = fm.description;
  return out;
}

/** 扫描目录下所有 SKILL.md（不使用缓存）。 */
export async function scanSkills(repoDir: string): Promise<DiscoveredSkill[]> {
  const files = await findFiles(repoDir, 'SKILL.md');
  const out: DiscoveredSkill[] = [];
  for (const file of files) {
    const dir = path.dirname(file);
    const fm = parseFrontmatter((await fs.readFile(file, 'utf8')) ?? '');
    const name = fm.name || path.basename(dir);
    const s: DiscoveredSkill = {
      name,
      declaredName: Boolean(fm.name),
      path: path.relative(repoDir, dir) || '.',
      contextTokens: skillTokens(name, fm.description),
    };
    if (fm.description) s.description = fm.description;
    out.push(s);
  }
  return out;
}

interface CacheFile {
  head: string;
  skills: DiscoveredSkill[];
}

/**
 * 发现仓库中的 Skill。结果按仓库 HEAD 缓存到 `<configDir>/cache/<cacheName>.json`；
 * 工作区有未提交改动或不是 git 仓库时不使用缓存。
 */
export async function discoverSkills(ctx: Ctx, repoDir: string, cacheName?: string): Promise<DiscoveredSkill[]> {
  if (!cacheName) return scanSkills(repoDir);
  const head = await git.tryHead(repoDir, ctx.signal);
  const cacheable = head !== null && !(await git.isDirty(repoDir, ctx.signal));
  const cachePath = path.join(ctx.cacheDir, `${cacheName.replace(/[^A-Za-z0-9_.@-]/g, '_')}.json`);
  if (cacheable) {
    try {
      const cached = await readJson<CacheFile>(cachePath);
      if (cached && cached.head === head && Array.isArray(cached.skills)) return cached.skills;
    } catch {
      // 缓存损坏则重扫
    }
  }
  const skills = await scanSkills(repoDir);
  if (cacheable) {
    try {
      await atomicWrite(cachePath, JSON.stringify({ head, skills } satisfies CacheFile, null, 2) + '\n');
    } catch {
      // 缓存写失败不影响结果
    }
  }
  return skills;
}
