import type { McpDef } from '../types.js';
import { AtmError } from '../errors.js';
import { validateMcpDef } from '../mcp/registry.js';

const bad = (message: string) => new AtmError('INVALID_MCP_DEF', message);
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(record) : [];
const variable = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase().replace(/^(?=\d)/, '_');
const interpolate = (value: string) => value.replace(/(?<!\$)\{([\w.-]+)\}/g, (_m, name: string) => '${' + variable(name) + '}');
export function mcpName(name: string): string { return name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'mcp-server'; }

export function packageMcpDefinition(spec: string): McpDef {
  if (spec.startsWith('npm:')) {
    const id = spec.slice(4);
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9.^~*+_-]+)?$/.test(id)) throw bad('请输入 npm:包名 或 npm:@组织/包名@版本');
    return { name: mcpName(id.replace(/@[^/]*$/, '').replace(/^@/, '')), transport: 'stdio', command: 'npx', args: ['-y', id] };
  }
  if (spec.startsWith('pypi:')) {
    const id = spec.slice(5);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:==[A-Za-z0-9.+_-]+)?$/.test(id)) throw bad('请输入 pypi:包名 或 pypi:包名==版本');
    return { name: mcpName(id.split('==')[0]!), transport: 'stdio', command: 'uvx', args: [id] };
  }
  throw bad('支持 npm:包名 或 pypi:包名；也可导入 MCP JSON 配置');
}

function argumentsFor(value: unknown): string[] {
  const args: string[] = [];
  for (const arg of list(value)) {
    if (arg.type === 'named') {
      if (typeof arg.name !== 'string' || !arg.name) throw bad('MCP 参数缺少名称');
      args.push(arg.name);
    }
    const raw = arg.value ?? arg.default;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') args.push(interpolate(String(raw)));
    else if (arg.type === 'positional' || arg.isRequired) {
      const name = String(arg.valueHint ?? arg.name ?? 'MCP_ARGUMENT');
      args.push('${' + variable(name) + '}');
    }
  }
  return args;
}

/** Convert the official server.json format into the existing runtime configuration contract. */
export function registryMcpDefinition(raw: Record<string, unknown>): McpDef {
  if (typeof raw.name !== 'string') throw bad('MCP server.json 缺少名称');
  const name = mcpName(raw.name);
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const remote = list(raw.remotes).find((r) => r.type === 'streamable-http' && typeof r.url === 'string');
  if (remote) {
    const headers: Record<string, string> = {};
    for (const header of list(remote.headers)) {
      if (typeof header.name !== 'string') continue;
      headers[header.name] = '${' + variable(header.name) + '}';
    }
    return validateMcpDef({ name, description, transport: 'http', url: interpolate(String(remote.url)), headers });
  }
  const pkg = list(raw.packages).find((p) => ['npm', 'pypi'].includes(String(p.registryType)) && record(p.transport).type === 'stdio');
  if (!pkg || typeof pkg.identifier !== 'string') throw bad('此 MCP 注册表条目没有可用的 HTTP、npm 或 PyPI 安装定义');
  const version = typeof pkg.version === 'string' && pkg.version !== 'latest' ? pkg.version : '';
  const base = packageMcpDefinition(`${pkg.registryType}:${pkg.identifier}${version ? (pkg.registryType === 'npm' ? '@' : '==') + version : ''}`);
  if (base.transport !== 'stdio') throw bad('MCP 包必须使用 stdio');
  const env: Record<string, string> = {};
  for (const entry of list(pkg.environmentVariables)) {
    if (typeof entry.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) throw bad('MCP 环境变量名称无效');
    // Preserve references; never persist literal secrets or guess local configuration values.
    env[entry.name] = '${' + entry.name + '}';
  }
  const runtimeArgs = argumentsFor(pkg.runtimeArguments);
  const baseArgs = base.args ?? [];
  return validateMcpDef({ ...base, name, description, env, args: [...runtimeArgs, ...baseArgs.filter((a) => !(a === '-y' && runtimeArgs.includes('-y'))), ...argumentsFor(pkg.packageArguments)] });
}
