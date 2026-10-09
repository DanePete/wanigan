#!/usr/bin/env node
// Run Node-mode code under Electron's own runtime, so native modules (SQLite,
// node-pty) load with the ABI the app ships with. Used by tests, the core and the CLI.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
