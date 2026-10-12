import type { McpDef } from '../types.js';
import { mapRecord, mapVars } from './merge.js';
import type { Adapter } from './types.js';

/**
 * Codex 的变量写法（契约 §6.2：暂定 `$VAR`，tech-design §13 待验证）。
 * 集中在这一个函数里，验证后只需改这里。
 */
export const codexVar = (name: string): string => `$${name}`;

export const codex: Adapter = {
  id: 'codex',
  label: 'Codex',
  skillEntry: null,
  mcpFile: '.codex/config.toml',
  format: 'toml',
  serversKey: 'mcp_servers',
  renderMcp(def: McpDef) {
    if (def.transport === 'http') {
      const out: Record<string, unknown> = { url: mapVars(def.url, codexVar) };
      const headers = mapRecord(def.headers, codexVar);
      if (headers) out.http_headers = headers;
      return out;
    }
    const out: Record<string, unknown> = { command: def.command };
    if (def.args?.length) out.args = def.args.map((a) => mapVars(a, codexVar));
    const env = mapRecord(def.env, codexVar);
    if (env) out.env = env;
    return out;
  },
};
