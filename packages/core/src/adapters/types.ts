import type { AgentId, McpDef } from '../types.js';

/** 每个 Agent 一个 Adapter：只描述「写到哪里、怎么渲染」，合并写入由 merge.ts 统一完成。 */
export interface Adapter {
  id: AgentId;
  label: string;
  /** 项目内 Skill 入口软链（相对项目根，指向 `../.agents/skills`）；null 表示原生读取 `.agents/skills` */
  skillEntry: string | null;
  /** MCP 配置文件（相对项目根） */
  mcpFile: string;
  format: 'json' | 'toml';
  /** MCP server 表在文档中的 key */
  serversKey: string;
  renderMcp(def: McpDef): Record<string, unknown>;
  /** 插件开关文件（只有 claude-code） */
  plugins?: { file: string; key: string };
}
