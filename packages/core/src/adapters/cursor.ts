import type { McpDef } from '../types.js';
import { mapRecord, mapVars } from './merge.js';
import type { Adapter } from './types.js';

/** Cursor 的变量写法：`${env:VAR}`。 */
export const cursorVar = (name: string): string => `\${env:${name}}`;

export const cursor: Adapter = {
  id: 'cursor',
  label: 'Cursor',
  skillEntry: '.cursor/skills',
  mcpFile: '.cursor/mcp.json',
  format: 'json',
  serversKey: 'mcpServers',
  renderMcp(def: McpDef) {
    if (def.transport === 'http') {
      const out: Record<string, unknown> = { url: mapVars(def.url, cursorVar) };
      const headers = mapRecord(def.headers, cursorVar);
      if (headers) out.headers = headers;
      return out;
    }
    const out: Record<string, unknown> = { command: def.command };
    if (def.args?.length) out.args = def.args.map((a) => mapVars(a, cursorVar));
    const env = mapRecord(def.env, cursorVar);
    if (env) out.env = env;
    return out;
  },
};
