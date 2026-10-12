#!/usr/bin/env node
import { main } from './main.js';

main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() }).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`✖ ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
