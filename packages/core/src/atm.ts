import path from 'node:path';
import type { Atm, ProjectSummary } from './types.js';
import { createCtx, expandHome, projectId, type CreateAtmOptions, type Ctx } from './context.js';
import { addProjectToRegistry, loadConfig, saveConfig } from './config.js';
import { AtmError } from './errors.js';
import { isDir } from './fs/walk.js';
import { requireManifest } from './manifest.js';
import { addTool } from './ops/add.js';
import { setAgents } from './ops/agents.js';
import { runBatch } from './ops/batch.js';
import { runDoctor, runFix } from './ops/doctor.js';
import { globalReport, migrateGlobal } from './ops/global.js';
import { initProject } from './ops/init.js';
import { inspectProject, loadShared } from './ops/inspect.js';
import { installProject } from './ops/install.js';
import { buildLibrary, cloneRepo, listRepos, saveMcpDef, searchLibrary } from './ops/library.js';
import { measureMcp } from './ops/measure.js';
import { pinSkill } from './ops/pin.js';
import { removeTool } from './ops/remove.js';
import { syncRepos } from './ops/sync.js';
import { startWatch } from './watch.js';

const ID_RE = /^[0-9a-f]{12}$/;

async function findRegistered(ctx: Ctx, idOrDir: string): Promise<string | null> {
  const cfg = await loadConfig(ctx);
  if (ID_RE.test(idOrDir)) {
    const hit = cfg.projects.find((p) => projectId(p) === idOrDir);
    if (hit) return hit;
  }
  const abs = expandHome(ctx.home, idOrDir);
  return cfg.projects.includes(abs) ? abs : null;
}

export function createAtm(opts: CreateAtmOptions = {}): Atm {
  const ctx = createCtx(opts);

  const resolveProject = async (idOrDir: string): Promise<string> => {
    const registered = await findRegistered(ctx, idOrDir);
    if (registered) return registered;
    const abs = expandHome(ctx.home, idOrDir);
    if (await isDir(abs)) return abs;
    throw new AtmError('NOT_FOUND', `project not found: ${idOrDir}`, { nextCommand: 'atm init' });
  };

  const summary = async (dir: string): Promise<ProjectSummary> => {
    const shared = await loadShared(ctx, await loadConfig(ctx));
    return (await inspectProject(ctx, shared, dir)).summary;
  };

  const requireDir = async (dir: string): Promise<string> => {
    const abs = expandHome(ctx.home, dir);
    if (!(await isDir(abs))) throw new AtmError('NOT_FOUND', `directory not found: ${abs}`, { nextCommand: 'check the path' });
    return abs;
  };

  const atm: Atm = {
    config: () => loadConfig(ctx),
    saveConfig: (patch) => saveConfig(ctx, patch),

    async projects() {
      const cfg = await loadConfig(ctx);
      const shared = await loadShared(ctx, cfg);
      const out: ProjectSummary[] = [];
      for (const dir of cfg.projects) out.push((await inspectProject(ctx, shared, dir)).summary);
      return out;
    },
    async registerProject(dir) {
      const abs = await requireDir(dir);
      await addProjectToRegistry(ctx, abs);
      return summary(abs);
    },
    async unregisterProject(idOrDir) {
      const hit = await findRegistered(ctx, idOrDir);
      if (!hit) throw new AtmError('NOT_FOUND', `project not registered: ${idOrDir}`, { nextCommand: 'atm ui' });
      const cfg = await loadConfig(ctx);
      await saveConfig(ctx, { projects: cfg.projects.filter((p) => p !== hit) });
    },
    async relocateProject(id, newDir) {
      const hit = await findRegistered(ctx, id);
      if (!hit) throw new AtmError('NOT_FOUND', `project not registered: ${id}`, { nextCommand: 'atm ui' });
      const abs = await requireDir(newDir);
      const cfg = await loadConfig(ctx);
      await saveConfig(ctx, { projects: cfg.projects.map((p) => (p === hit ? abs : p)) });
      return summary(abs);
    },
    resolveProject,
    projectId: (p) => projectId(path.resolve(p)),

    init: async (dir, o) => initProject(ctx, await requireDirOrId(dir), o),
    add: async (dir, spec, o) => addTool(ctx, await resolveProject(dir), spec, o),
    remove: async (dir, name, o) => removeTool(ctx, await resolveProject(dir), name, o),
    install: async (dir, o) => installProject(ctx, await resolveProject(dir), o),
    setAgents: async (dir, agents, o) => setAgents(ctx, await resolveProject(dir), agents, o),
    sync: (repos, o) => syncRepos(ctx, repos, o),
    async list(dir) {
      const abs = await resolveProject(dir);
      await requireManifest(abs); // 未初始化 / 清单无效时抛出对应错误
      const shared = await loadShared(ctx, await loadConfig(ctx));
      const snap = await inspectProject(ctx, shared, abs);
      if (!snap.detail) throw new AtmError('NOT_INITIALIZED', `${abs} has no .agents/tools.json`, { nextCommand: 'atm init' });
      return snap.detail;
    },
    doctor: (target, o) => runDoctor(ctx, { resolveProject }, target, o),
    fix: (ids, o) => runFix(ctx, { resolveProject }, ids, o),
    measure: async (dir, name) => measureMcp(ctx, await resolveProject(dir), name),
    pin: async (dir, skill, rev, o) => pinSkill(ctx, await resolveProject(dir), skill, rev, o),

    library: () => buildLibrary(ctx),
    search: (q) => searchLibrary(ctx, q),
    repos: () => listRepos(ctx),
    cloneRepo: (repo) => cloneRepo(ctx, repo),
    saveMcpDef: (def, scope) => saveMcpDef(ctx, def, scope, resolveProject),
    global: () => globalReport(ctx),
    migrate: (spec, o) => migrateGlobal(ctx, spec, resolveProject, o),
    batch: (ops, o) => runBatch(ctx, ops, resolveProject, o),
    async diffGenerated(dir) {
      return (await installProject(ctx, await resolveProject(dir), { dryRun: true })).files;
    },
    watch(dirs, cb) {
      let stop: (() => void) | null = null;
      let cancelled = false;
      void (async () => {
        const cfg = await loadConfig(ctx);
        const resolved: string[] = [];
        for (const d of dirs.length ? dirs : cfg.projects) {
          try {
            resolved.push(await resolveProject(d));
          } catch {
            // 跳过不存在的项目
          }
        }
        if (!cancelled) stop = startWatch(resolved, cfg.mcpRegistry, cb);
      })().catch(() => undefined);
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  };

  async function requireDirOrId(dir: string): Promise<string> {
    const registered = await findRegistered(ctx, dir);
    return registered ?? requireDir(dir);
  }

  return atm;
}
