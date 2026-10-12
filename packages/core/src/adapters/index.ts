import type { AgentId } from '../types.js';
import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import type { Adapter } from './types.js';

export const ADAPTERS: Record<AgentId, Adapter> = {
  'claude-code': claudeCode,
  cursor,
  codex,
};

export function adapterFor(id: AgentId): Adapter {
  return ADAPTERS[id];
}

export type { Adapter };
