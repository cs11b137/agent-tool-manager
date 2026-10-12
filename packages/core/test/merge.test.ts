import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { AtmError, validateMcpDef, type McpDef } from '../src/index.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { detectIndent, mergeEntries, mergeIntoFile } from '../src/adapters/merge.js';

describe('mergeEntries', () => {
  it('only touches managed entries', () => {
    const current = { hand: { command: 'mine' }, old: { command: 'atm-old' }, keep: { command: 'atm-keep' } };
    const { next, managed } = mergeEntries(current, { keep: { command: 'atm-keep-2' }, fresh: { command: 'new' } }, ['old', 'keep'], { file: '.mcp.json' });
    expect(next).toEqual({ hand: { command: 'mine' }, keep: { command: 'atm-keep-2' }, fresh: { command: 'new' } });
    expect(managed).toEqual(['fresh', 'keep']);
  });

  it('throws CONFLICT on a hand-written entry with the same name, adopt takes it over', () => {
    const current = { figma: { command: 'hand' } };
    try {
      mergeEntries(current, { figma: { command: 'atm' } }, [], { file: '.mcp.json', retryCommand: 'atm add mcp figma' });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AtmError);
      expect((e as AtmError).code).toBe('CONFLICT');
      expect((e as AtmError).nextCommand).toBe('atm add mcp figma --adopt');
    }
    const { next, managed } = mergeEntries(current, { figma: { command: 'atm' } }, [], { file: '.mcp.json', adopt: true });
    expect(next).toEqual({ figma: { command: 'atm' } });
    expect(managed).toEqual(['figma']);
  });
});

describe('mergeIntoFile', () => {
  it('preserves 4-space and tab indentation and unrelated keys', () => {
    const before4 = '{\n    "other": true,\n    "mcpServers": {\n        "hand": {\n            "command": "x"\n        }\n    }\n}\n';
    const r4 = mergeIntoFile({ before: before4, format: 'json', key: 'mcpServers', desired: { a: { command: 'y' } }, managedOld: [], file: '.mcp.json' });
    expect(r4.after).toBe('{\n    "other": true,\n    "mcpServers": {\n        "hand": {\n            "command": "x"\n        },\n        "a": {\n            "command": "y"\n        }\n    }\n}\n');
    const beforeTab = '{\n\t"mcpServers": {}\n}';
    const rt = mergeIntoFile({ before: beforeTab, format: 'json', key: 'mcpServers', desired: { a: { command: 'y' } }, managedOld: [], file: '.mcp.json' });
    expect(rt.after).toBe('{\n\t"mcpServers": {\n\t\t"a": {\n\t\t\t"command": "y"\n\t\t}\n\t}\n}\n');
    expect(detectIndent(null)).toBe(2);
    expect(detectIndent('{}')).toBe(2);
  });

  it('returns before untouched when nothing managed changes', () => {
    const before = '{"mcpServers":{"a":{"command":"y"}}}';
    const r = mergeIntoFile({ before, format: 'json', key: 'mcpServers', desired: { a: { command: 'y' } }, managedOld: ['a'], file: '.mcp.json' });
    expect(r.after).toBe(before);
  });

  it('does not create a file when there is nothing to write', () => {
    const r = mergeIntoFile({ before: null, format: 'json', key: 'mcpServers', desired: {}, managedOld: ['gone'], file: '.mcp.json' });
    expect(r.after).toBeNull();
    expect(r.managed).toEqual([]);
  });

  it('merges TOML keeping hand-written tables', () => {
    const before = 'model = "o3"\n\n[mcp_servers.hand]\ncommand = "h"\n';
    const r = mergeIntoFile({ before, format: 'toml', key: 'mcp_servers', desired: { a: { command: 'y', env: { K: '$K' } } }, managedOld: [], file: '.codex/config.toml' });
    expect(parseToml(r.after!)).toEqual({ model: 'o3', mcp_servers: { hand: { command: 'h' }, a: { command: 'y', env: { K: '$K' } } } });
  });
});

const defs: McpDef[] = [
  validateMcpDef({ name: 'figma', description: 'Figma', transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'], env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' } }),
  validateMcpDef({ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } }),
  validateMcpDef({ name: 'plain', transport: 'stdio', command: 'my-mcp' }),
];

function render(agent: keyof typeof ADAPTERS, before: string | null = null): string {
  const a = ADAPTERS[agent];
  const desired = Object.fromEntries(defs.map((d) => [d.name, a.renderMcp(d)]));
  return mergeIntoFile({ before, format: a.format, key: a.serversKey, desired, managedOld: [], file: a.mcpFile }).after!;
}

describe('adapter rendering', () => {
  it('claude-code .mcp.json', () => {
    expect(render('claude-code')).toMatchSnapshot();
  });
  it('cursor .cursor/mcp.json', () => {
    expect(render('cursor')).toMatchSnapshot();
  });
  it('codex .codex/config.toml', () => {
    expect(render('codex', '# user settings\nmodel = "gpt-5"\n')).toMatchSnapshot();
  });
  it('claude-code .claude/settings.json enabledPlugins', () => {
    const before = '{\n  "permissions": { "allow": ["Bash(ls:*)"] },\n  "enabledPlugins": { "mine@x": false }\n}\n';
    const r = mergeIntoFile({
      before,
      format: 'json',
      key: 'enabledPlugins',
      desired: { 'security-guidance@claude-plugins-official': true },
      managedOld: [],
      file: '.claude/settings.json',
    });
    expect(r.after).toMatchSnapshot();
  });
});
