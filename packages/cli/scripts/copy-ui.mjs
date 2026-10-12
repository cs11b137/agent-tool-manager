// Copy the built UI (packages/ui/dist) into dist/ui so `atm ui` can serve it. Silently skipped when the UI is not built.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..', 'ui', 'dist');
const dest = path.resolve(here, '..', 'dist', 'ui');

if (fs.existsSync(path.join(src, 'index.html'))) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

// tsc does not set the executable bit on the bin entry.
const bin = path.resolve(here, '..', 'dist', 'bin.js');
if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755);
