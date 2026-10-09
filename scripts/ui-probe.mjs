#!/usr/bin/env node
// Ad-hoc probe: start the gateway, open one route, run an expression in the page.
//   node scripts/ui-probe.mjs '#/p/NS/board?card=NS-7' 'document.title' [screenshot.png]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const gateway = spawn(require('electron'), [join(root, 'scripts/ui-gateway.ts')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((ok) => { let b = ''; gateway.stdout.on('data', (c) => { b += c; const m = b.match(/gateway (http:\/\/\S+)/); if (m) ok(m[1]); }); });
const bridge = (await import('node:fs')).readFileSync(join(root, 'scripts/ui-sweep.mjs'), 'utf8').match(/const BRIDGE = `([\s\S]*?)`;/)[1];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(bridge);
page.on('console', (m) => console.log('console:', m.type(), m.text()));
await page.goto(base + process.argv[2]);
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(process.argv[3]), null, 2));
if (process.argv[4]) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.argv[4] });
  console.log('screenshot', process.argv[4]);
}
await browser.close();
gateway.kill('SIGTERM');
