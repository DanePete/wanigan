#!/usr/bin/env node
// Package Wanigan 2 for macOS (arm64). electron-builder's dir target rewrites the
// source package.json, so it is snapshotted and restored, and the native addons
// are rebuilt for this machine afterwards whether packaging passed or failed.
// `--out <folder>` builds somewhere other than release/, so an app running from
// release/ (its core reads its files as it goes) is never rebuilt underneath.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const snapshot = readFileSync(pkgPath, 'utf8');
const bin = (name) => join(root, 'node_modules', '.bin', name);
const outAt = process.argv.indexOf('--out');
const out = outAt >= 0 ? resolve(process.argv[outAt + 1]) : join(root, 'release');
let code = 0;
try {
  execFileSync(bin('electron-vite'), ['build'], { cwd: root, stdio: 'inherit' });
  const r = spawnSync(bin('electron-builder'), ['--mac', '--arm64', '--publish', 'never', `-c.directories.output=${out}`], { cwd: root, stdio: 'inherit' });
  code = r.status ?? 1;
} finally {
  if (readFileSync(pkgPath, 'utf8') !== snapshot) {
    writeFileSync(pkgPath, snapshot);
    console.log('restored package.json, which the build rewrote');
  }
  const restored = spawnSync(bin('electron-rebuild'), ['-f', '-w', 'node-pty,better-sqlite3'], { cwd: root, stdio: 'inherit' });
  if (restored.status !== 0) {
    console.error(`Native addon restoration failed: ${restored.error?.message ?? restored.signal ?? `exit ${restored.status}`}`);
    if (code === 0) code = restored.status ?? 1;
  }
  if (existsSync(out)) writeFileSync(join(out, '.metadata_never_index'), ''); // keep build output out of Spotlight
}
process.exit(code);
