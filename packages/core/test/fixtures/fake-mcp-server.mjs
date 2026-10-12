#!/usr/bin/env node
// 极简 MCP server：newline-delimited JSON-RPC over stdio，只回答 initialize 与 tools/list（两页）。
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const page1 = [
  { name: 'echo', description: 'Echo the input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];
const page2 = [
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];

process.stderr.write(`fake server started, FAKE_TOKEN=${process.env.FAKE_TOKEN ? 'set' : 'unset'}\n`);
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0.0.1' } } });
  } else if (msg.method === 'tools/list') {
    if (msg.params?.cursor === 'p2') send({ jsonrpc: '2.0', id: msg.id, result: { tools: page2 } });
    else send({ jsonrpc: '2.0', id: msg.id, result: { tools: page1, nextCursor: 'p2' } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
