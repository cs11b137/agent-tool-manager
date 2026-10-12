#!/usr/bin/env node
// 极简 MCP server：newline-delimited JSON-RPC over stdio，只回答 initialize 与 tools/list（两页）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

// FAKE_MODE=hang：起一个孙进程（同一进程组），把它的 pid 写到 FAKE_PID_FILE，然后永不响应
if (process.env.FAKE_MODE === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_PID_FILE, String(grandchild.pid));
  setInterval(() => {}, 1000);
}

const rl = readline.createInterface({ input: process.stdin });
// FAKE_MODE=split：逐字节写出响应，多字节 UTF-8 字符会被拆到不同的 chunk 里
const send = async (msg) => {
  const bytes = Buffer.from(JSON.stringify(msg) + '\n', 'utf8');
  if (process.env.FAKE_MODE !== 'split') return void process.stdout.write(bytes);
  for (const b of bytes) {
    await new Promise((r) => process.stdout.write(Buffer.from([b]), r));
    await new Promise((r) => setImmediate(r));
  }
};
const page1 = [
  { name: 'echo', description: 'Echo the input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];
const page2 = [
  { name: 'add', description: process.env.FAKE_MODE === 'split' ? '两个数相加 𠀀' : 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];

process.stderr.write(`fake server started, FAKE_TOKEN=${process.env.FAKE_TOKEN ? 'set' : 'unset'}\n`);
if (process.env.FAKE_MODE !== 'hang') rl.on('line', (line) => {
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
