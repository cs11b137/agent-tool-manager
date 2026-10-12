import type { McpDef } from '../types.js';
import type { Adapter } from './types.js';

export const claudeCode: Adapter = {
  id: 'claude-code',
  label: 'Claude Code',
  skillEntry: '.claude/skills',
  mcpFile: '.mcp.json',
  format: 'json',
  serversKey: 'mcpServers',
  plugins: { file: '.claude/settings.json', key: 'enabledPlugins' },
  renderMcp(def: McpDef) {
    // Claude Code 原生支持 `${VAR}`，原样保留
    if (def.transport === 'http') {
      const out: Record<string, unknown> = { type: 'http', url: def.url };
      if (def.headers && Object.keys(def.headers).length) out.headers = { ...def.headers };
      return out;
    }
    const out: Record<string, unknown> = { command: def.command };
    if (def.args?.length) out.args = [...def.args];
    if (def.env && Object.keys(def.env).length) out.env = { ...def.env };
    return out;
  },
};
