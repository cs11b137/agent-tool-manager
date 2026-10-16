import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PackageFile } from './source-files.js';
import { readToolSource } from './tool-source.js';
import { registryMcpDefinition } from './native-mcp.js';
import type { Ctx } from '../context.js';
import type { GlobalConfig, ToolKind, ToolPackageInput, ToolPackageResult, McpDef } from '../types.js';
import { loadConfig } from '../config.js';
import { AtmError } from '../errors.js';
import { atomicWrite } from '../fs/atomic.js';
import { withLock } from '../fs/lock.js';
import { git } from '../git.js';
import { isToolName } from '../manifest.js';
import { mcpVarNames, validateMcpDef } from '../mcp/registry.js';
import { parseFrontmatter } from '../skills/frontmatter.js';
import { SHARED_MARKETPLACE } from './shared-repository.js';

const invalid = (message: string) => new AtmError('INVALID_MANIFEST', message);
const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n');
const stat = (file: string) => fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
interface Candidate { kind: ToolKind; name: string; target: string; files: Map<string, PackageFile>; assetRoot?: string }

function parseJson(file: PackageFile, name: string): Record<string, unknown> {
  try {
    const obj: unknown = JSON.parse(file.content.toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
    return obj as Record<string, unknown>;
  } catch { throw invalid(`JSON 格式无效：${name}`); }
}
function detect(files: Map<string, PackageFile>, cfg: GlobalConfig): Candidate[] {
  const tools: Candidate[] = [];
  const consumed: string[] = [];
  const under = (file: string, prefix: string) => !prefix || file.startsWith(prefix);
  const add = (kind: ToolKind, name: unknown, prefix: string, single?: PackageFile) => {
    if (!isToolName(name)) throw invalid(`工具名称无效：${String(name)}`);
    if (tools.some((t) => t.kind === kind && t.name.toLowerCase() === name.toLowerCase())) throw invalid(`工具包包含同名工具：${name}`);
    const selected = single ? new Map([['', single]]) : new Map([...files].filter(([file]) => under(file, prefix)).map(([file, value]) => [file.slice(prefix.length), value]));
    const target = kind === 'mcp' ? path.join(cfg.mcpRegistry, `${name}.json`) : path.join(cfg.root, kind === 'skill' ? 'skills' : 'plugins', name);
    tools.push({ kind, name, target, files: selected });
    if (!single) consumed.push(prefix);
  };
  const addMcp = (definition: McpDef, file: string) => {
    let def = definition;
    let assets = false;
    const assetRoot = path.join(cfg.root, '.mcp-packages', definition.name);
    if (def.transport === 'stdio') {
      const resolve = (value: string, command = false) => {
        if (path.isAbsolute(value) || value.includes('${')) return value;
        const rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), value));
        if (files.has(rel)) { assets = true; return path.join(assetRoot, rel); }
        if (value.startsWith('./') || value.startsWith('../') || (!command && /\.(?:[cm]?js|py|ts)$/.test(value))) throw invalid('MCP 引用的本地文件缺失，请导入完整目录或 GitHub 仓库：' + value);
        return value;
      };
      def = { ...def, command: resolve(def.command, true), args: def.args?.map((arg) => resolve(arg)) };
    }
    add('mcp', def.name, '', { content: json(def), executable: false });
    if (assets) {
      const candidate = tools.at(-1)!;
      candidate.assetRoot = assetRoot;
      for (const [name, value] of files) candidate.files.set(name, value);
    }
  };
  // A plugin owns all its nested skills, commands, hooks and assets.
  for (const [file, value] of [...files].sort(([a], [b]) => a.length - b.length)) {
    if (!file.endsWith('.claude-plugin/plugin.json')) continue;
    const prefix = file.slice(0, -'.claude-plugin/plugin.json'.length);
    if (prefix && !prefix.endsWith('/')) continue;
    if (consumed.some((p) => under(file, p))) continue;
    const manifest = parseJson(value, file);
    for (const field of ['commands', 'agents', 'skills', 'hooks', 'mcpServers', 'lspServers']) {
      const references = Array.isArray(manifest[field]) ? manifest[field] as unknown[] : [manifest[field]];
      for (const reference of references) {
        if (typeof reference !== 'string') continue;
        const rel = path.posix.normalize(reference);
        if (path.posix.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw invalid('插件文件引用不能超出插件目录');
        const target = prefix + rel;
        if (![...files.keys()].some((name) => name === target || name.startsWith(target + '/'))) throw invalid('插件引用文件缺失，请导入完整插件目录：' + reference);
      }
    }
    add('plugin', manifest.name, prefix);
  }
  for (const [file, value] of [...files].sort(([a], [b]) => a.length - b.length)) {
    if (consumed.some((p) => under(file, p))) continue;
    if (file === 'SKILL.md' || file.endsWith('/SKILL.md')) {
      const prefix = file.slice(0, -'SKILL.md'.length);
      const meta = parseFrontmatter(value.content.toString('utf8'));
      add('skill', meta.name || prefix.split('/').at(-2), prefix);
    }
  }
  for (const [file, value] of files) {
    if (consumed.some((p) => under(file, p)) || !file.endsWith('.json')) continue;
    const parts = file.split('/');
    // Explicit registry directories, or a single definition at archive/wrapper root.
    const registry = parts.includes('mcp-registry') || parts.includes('mcp');
    if (!registry && parts.length > 2 && !file.endsWith('/.mcp.json')) continue;
    let raw: Record<string, unknown>;
    try { raw = parseJson(value, file); } catch (e) { if (registry || file.endsWith('.mcp.json')) throw e; continue; }
    const servers = raw.mcpServers ?? raw.servers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const [name, def] of Object.entries(servers)) {
        const valid = validateMcpDef(def, file, name);
        addMcp(valid, file);
      }
    } else if (Array.isArray(raw.packages) || Array.isArray(raw.remotes)) {
      const def = registryMcpDefinition(raw);
      addMcp(def, file);
    } else if (registry || raw.command !== undefined || raw.url !== undefined || raw.transport !== undefined) {
      const def = validateMcpDef(raw, file, path.posix.basename(file, '.json'));
      addMcp(def, file);
    }
  }
  if (!tools.length) throw invalid('未找到工具：请包含 SKILL.md、.claude-plugin/plugin.json 或 MCP JSON 定义');
  return tools;
}

async function realDirectory(dir: string, created?: string[]): Promise<void> {
  const parent = path.dirname(dir);
  if (parent !== dir) await realDirectory(parent, created);
  const s = await stat(dir);
  if (s) { if (!s.isDirectory()) throw new AtmError('CONFLICT', `目录被文件或软链占用：${dir}`); return; }
  if (created) { await fs.mkdir(dir); created.push(dir); }
}

export async function importToolPackage(ctx: Ctx, input: ToolPackageInput): Promise<ToolPackageResult> {
  if (!input?.source) throw invalid('请选择工具来源');
  if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256))) throw invalid('安装前请先预览工具包');
  const cfg = await loadConfig(ctx);
  if (!cfg.sharedRepository || !(await git.isRepoRoot(cfg.root, ctx.signal))) throw new AtmError('NOT_INITIALIZED', '请先创建共享仓库');
  const source = await readToolSource(ctx, input.source);
  const hash = createHash('sha256');
  for (const [name, file] of [...source.files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([name, file.content.length, file.executable])); hash.update(file.content);
  }
  const digest = hash.digest('hex');
  if (input.sha256 && digest !== input.sha256) throw new AtmError('CONFLICT', '工具包已变化，请重新预览后安装');
  const destinationCfg = { ...cfg, root: await fs.realpath(cfg.root), mcpRegistry: await fs.realpath(cfg.mcpRegistry) };
  let candidates = detect(source.files, destinationCfg);
  if (input.selection !== undefined) {
    if (!Array.isArray(input.selection) || !input.selection.length || input.selection.some((key) => typeof key !== 'string' || !candidates.some((c) => key === c.kind + ':' + c.name))) throw invalid('请选择有效的待安装工具');
    candidates = candidates.filter((c) => input.selection!.includes(c.kind + ':' + c.name));
  }
  for (const candidate of candidates.filter((c) => c.kind === 'mcp')) {
    const def = validateMcpDef(JSON.parse(candidate.files.get('')!.content.toString('utf8')));
    const vars = mcpVarNames(def).filter((name) => !ctx.env[name]);
    if (vars.length) source.warnings.push('启动此 MCP 前需要设置环境变量：' + vars.join(', '));
    if (def.transport === 'stdio' && ['npx', 'uvx'].includes(def.command)) source.warnings.push('MCP 依赖会在 Agent 首次启动时由 npx 或 uvx 下载，请先安装对应运行环境。');
  }
  source.warnings = [...new Set(source.warnings)];
  return withLock(path.join(ctx.configDir, '.lock'), async () => {
    const current = await loadConfig(ctx);
    if (current.root !== cfg.root || current.mcpRegistry !== cfg.mcpRegistry || !current.sharedRepository) throw new AtmError('CONFLICT', '共享仓库设置已变化，请重新预览');
    const tools: ToolPackageResult['tools'] = [];
    for (const candidate of candidates) {
      await realDirectory(path.dirname(candidate.target));
      if (candidate.kind !== 'mcp' && await git.isRepoRoot(path.dirname(candidate.target))) throw new AtmError('CONFLICT', '目标工具目录已被独立仓库占用');
      tools.push({ kind: candidate.kind, name: candidate.name, path: candidate.target, files: candidate.files.size, conflict: !!(await stat(candidate.target)) || !!(candidate.assetRoot && await stat(candidate.assetRoot)) });
    }
    const catalogPath = path.join(destinationCfg.root, '.claude-plugin', 'marketplace.json');
    let catalog: { name: string; owner?: unknown; plugins: Array<{ name: string; source: string }> } | undefined;
    if (candidates.some((c) => c.kind === 'plugin')) {
      await realDirectory(path.dirname(catalogPath));
      const st = await stat(catalogPath);
      if (st && !st.isFile()) throw new AtmError('CONFLICT', 'marketplace.json 必须是普通文件');
      try { catalog = st ? JSON.parse(await fs.readFile(catalogPath, 'utf8')) : { name: SHARED_MARKETPLACE, owner: { name: 'Agent Tool Manager' }, plugins: [] }; }
      catch { throw new AtmError('CONFLICT', 'marketplace.json 格式无效'); }
      if (!catalog || catalog.name !== SHARED_MARKETPLACE || !Array.isArray(catalog.plugins) || catalog.plugins.some((p) => !p || typeof p.name !== 'string')) throw new AtmError('CONFLICT', '共享 marketplace 格式无效');
      for (const tool of tools.filter((t) => t.kind === 'plugin')) tool.conflict ||= catalog.plugins.some((p) => p.name.toLowerCase() === tool.name.toLowerCase());
    }
    const result: ToolPackageResult = { installed: false, sha256: digest, tools, warnings: source.warnings, totalBytes: candidates.reduce((sum, c) => sum + [...c.files.values()].reduce((n, f) => n + f.content.length, 0), 0) };
    if (result.totalBytes > 50 * 1024 * 1024) throw invalid('所选工具安装后不能超过 50 MB');
    if (!input.sha256) return result;
    if (tools.some((t) => t.conflict)) throw new AtmError('ALREADY_EXISTS', `工具已存在：${tools.filter((t) => t.conflict).map((t) => t.name).join(', ')}`);
    const createdFiles: string[] = [], createdDirs: string[] = [];
    try {
      for (const candidate of candidates) {
        for (const [rel, file] of candidate.files) {
          ctx.signal?.throwIfAborted();
          const destination = candidate.kind === 'mcp' ? (rel ? path.join(candidate.assetRoot!, rel) : candidate.target) : path.join(candidate.target, rel);
          await realDirectory(path.dirname(destination), createdDirs);
          // Track ownership before writing, so partial disk writes are rolled back too.
          const handle = await fs.open(destination, 'wx', file.executable ? 0o755 : 0o644);
          createdFiles.push(destination);
          try { await handle.writeFile(file.content); } finally { await handle.close(); }
        }
      }
      if (catalog) {
        catalog.plugins.push(...candidates.filter((c) => c.kind === 'plugin').map((c) => ({ name: c.name, source: `./plugins/${c.name}` })));
        await realDirectory(path.dirname(catalogPath), createdDirs);
        await atomicWrite(catalogPath, json(catalog).toString());
      }
    } catch (e) {
      for (const file of createdFiles.reverse()) await fs.unlink(file);
      for (const dir of createdDirs.reverse()) await fs.rmdir(dir).catch(() => undefined);
      throw e;
    }
    ctx.emit({ type: 'library.changed' });
    ctx.activity({ level: 'info', message: `已安装 ${tools.length} 个工具：${tools.map((t) => t.name).join(', ')}` });
    return { ...result, installed: true };
  });
}
