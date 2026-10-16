import path from 'node:path';
import type { Ctx } from '../context.js';
import { expandHome } from '../context.js';
import type { ToolPackageSource } from '../types.js';
import { AtmError } from '../errors.js';
import { downloadPackage, MAX_PACKAGE_BYTES } from './package-download.js';
import { readZip, readDirectory, validateSourcePath, type PackageFile } from './source-files.js';
import { packageMcpDefinition } from './native-mcp.js';

const bad = (message: string) => new AtmError('INVALID_MANIFEST', message);
export interface GitHubSource { repo: string; ref?: string; path?: string }
export function githubSource(value: string, ref?: string, subpath?: string): GitHubSource {
  if (typeof value !== 'string') throw bad('请输入 GitHub 仓库地址');
  let raw = value.trim();
  if (/(?:^|\/)\.\.(?:\/|$)/.test(raw)) throw bad('GitHub 路径无效');
  if (raw.startsWith('https://')) {
    const url = new URL(raw);
    if (url.hostname !== 'github.com' || url.username || url.password || url.port) throw bad('请输入 GitHub 仓库地址或 owner/repo');
    raw = decodeURIComponent(url.pathname).replace(/^\/|\/$/g, '');
  }
  const [owner, repository, route, ...rest] = raw.split('/');
  if (!owner || !repository || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository) || owner === '.' || owner === '..' || repository === '.' || repository === '..') throw bad('请输入 GitHub 仓库地址或 owner/repo');
  if (route && !['tree', 'blob'].includes(route)) throw bad('GitHub 地址应指向仓库、目录或文件');
  const routeRef = rest[0];
  const routePath = ref && rest.join('/').startsWith(ref + '/') ? rest.join('/').slice(ref.length + 1) : rest.slice(1).join('/');
  const source = { repo: `${owner}/${repository.replace(/\.git$/, '')}`, ref: ref?.trim() || routeRef, path: subpath?.trim() || routePath || undefined };
  if (source.ref && (/^[\s-]|[\x00-\x20~^:?*\\\[\]]/.test(source.ref) || source.ref.includes('..'))) throw bad('GitHub 分支或版本无效');
  if (source.path) validateSourcePath(source.path.replace(/\/$/, ''));
  return source;
}

async function githubFiles(source: GitHubSource, signal?: AbortSignal): Promise<Map<string, PackageFile>> {
  const normalized = githubSource(source.repo, source.ref, source.path);
  // codeload retrieves a Git snapshot without requiring the user to package or download a ZIP.
  const bytes = await downloadPackage(`https://codeload.github.com/${normalized.repo}/zip/${encodeURIComponent(normalized.ref ?? 'HEAD')}`, signal);
  const archive = await readZip(bytes, signal);
  const root = [...archive.keys()][0]?.split('/')[0];
  if (!root) throw bad('GitHub 仓库为空');
  let files = new Map([...archive].map(([name, value]) => [name.slice(root.length + 1), value]));
  let subpath = normalized.path?.replace(/\/$/, '');
  if (subpath) {
    if (subpath.endsWith('/SKILL.md') || subpath === 'SKILL.md') subpath = path.posix.dirname(subpath);
    else if (subpath.endsWith('.claude-plugin/plugin.json')) subpath = subpath.slice(0, -'.claude-plugin/plugin.json'.length).replace(/\/$/, '') || '.';
    if (subpath !== '.') {
      const single = files.get(subpath);
      files = single ? nativeFile(path.posix.basename(subpath), single.content) : new Map([...files].filter(([name]) => name.startsWith(subpath + '/')).map(([name, value]) => [name.slice(subpath!.length + 1), value]));
    }
  }
  if (!files.size) throw bad('GitHub 仓库中没有找到所选路径');
  return files;
}

function nativeFile(filename: string, bytes: Buffer): Map<string, PackageFile> {
  let name = path.posix.basename(filename);
  let content = bytes;
  if (/\.md$/i.test(name)) name = 'SKILL.md';
  else if (name === 'plugin.json') name = '.claude-plugin/plugin.json';
  else if (/\.json$/i.test(name)) {
    try {
      const raw = JSON.parse(bytes.toString('utf8'));
      if (raw?.server && typeof raw.server === 'object') content = Buffer.from(JSON.stringify(raw.server));
      if (raw?.plugins && raw?.name) throw bad('这是插件市场目录，请搜索并选择具体插件，或导入完整插件仓库');
    } catch (e) { if (e instanceof AtmError) throw e; throw bad('MCP 或插件 JSON 格式无效'); }
  } else throw bad('支持 SKILL.md、MCP JSON、plugin.json、.skill、ZIP 或完整工具目录');
  validateSourcePath(name);
  return new Map([[name, { content, executable: false }]]);
}

export async function readToolSource(ctx: Ctx, source: ToolPackageSource): Promise<{ files: Map<string, PackageFile>; warnings: string[] }> {
  const warnings: string[] = [];
  if (source.type === 'directory') {
    if (typeof source.path !== 'string' || !source.path.trim()) throw bad('请选择工具目录');
    return { files: await readDirectory(expandHome(ctx.home, source.path), ctx.signal), warnings };
  }
  if (source.type === 'github') return { files: await githubFiles(githubSource(source.repo, source.ref, source.path), ctx.signal), warnings };
  if (source.type === 'mcp') {
    if (typeof source.spec !== 'string') throw bad('请输入 MCP 包名');
    const def = packageMcpDefinition(source.spec.trim());
    warnings.push('MCP 依赖会在 Agent 首次启动时由 npx 或 uvx 下载，请先安装对应运行环境。');
    return { files: nativeFile(`${def.name}.json`, Buffer.from(JSON.stringify(def))), warnings };
  }
  let bytes: Buffer, filename: string;
  if (source.type === 'url') {
    if (typeof source.url !== 'string') throw bad('请输入工具地址');
    const value = source.url.trim();
    if (value.startsWith('npm:') || value.startsWith('pypi:')) return readToolSource(ctx, { type: 'mcp', spec: value });
    if (/^(?:https:\/\/github\.com\/[^/]+\/[^/]+(?:\/(?:tree|blob)\/|\/?$)|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$)/.test(value)) return { files: await githubFiles(githubSource(value), ctx.signal), warnings };
    let url: URL;
    try { url = new URL(value); } catch { throw bad('请输入工具文件地址、GitHub 仓库或 MCP 包名'); }
    filename = url.hostname === 'registry.modelcontextprotocol.io' ? 'server.json' : path.posix.basename(decodeURIComponent(url.pathname));
    try { bytes = await downloadPackage(value, ctx.signal); }
    catch (e) { if (e instanceof AtmError) throw e; throw bad(`下载失败：${(e as Error).message}`); }
    if (url.hostname === 'raw.githubusercontent.com' && filename === 'SKILL.md') warnings.push('单独下载 SKILL.md 不包含引用的脚本和资源；如需完整目录，请使用 GitHub 仓库地址。');
  } else if (source.type === 'upload') {
    const { base64 } = source;
    filename = source.filename;
    if (typeof filename !== 'string' || !filename) throw bad('请选择工具文件');
    if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_PACKAGE_BYTES / 3) * 4 || base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64)) throw bad('工具内容无效或超过 20 MB');
    bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) throw bad('工具编码无效');
  } else throw bad('不支持此工具来源');
  if (!bytes.length || bytes.length > MAX_PACKAGE_BYTES) throw bad('工具文件不能为空且不能超过 20 MB');
  const zip = bytes.length >= 4 && bytes.readUInt16LE(0) === 0x4b50;
  return { files: zip ? await readZip(bytes, ctx.signal) : nativeFile(filename, bytes), warnings };
}
