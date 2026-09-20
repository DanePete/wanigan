#!/usr/bin/env node
// Real production Electron main/preload, synthetic credential-free CLI and PTY.
// Launch -> quit drain -> reopen -> fresh offline maintenance startup.
// No installed app or provider data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { setTimeout as pause } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
assert.equal(process.version, 'v22.23.2', 'Use the repository Node version.');
assert.equal(process.platform, 'darwin', 'This native lifecycle fixture currently verifies macOS only.');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-native-recovery-')));
const profile = path.join(directory, 'profile'), home = path.join(directory, 'home');
const packRoot = path.join(directory, 'provider-packs'), bin = path.join(directory, 'bin');
const project = path.join(directory, 'checkout'), appData = path.join(directory, 'app-data');
const backupDirectory = path.join(directory, 'backup');
for (const folder of [profile, home, packRoot, bin, project, appData]) fs.mkdirSync(folder);
const env = { HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  SHELL: '/bin/sh', TMPDIR: directory, LANG: 'en_US.UTF-8', WANIGAN_PROVIDER_PACKS_DIR: packRoot,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
fs.writeFileSync(path.join(home, '.profile'), `export PATH='${env.PATH}'\n`);
const marker = path.join(directory, 'launches.jsonl');
const cli = path.join(bin, 'wanigan-fixture-agent');
fs.writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('wanigan-fixture-agent 1');process.exit(0)}
if(process.argv.includes('--help')){console.log('Synthetic credential-free terminal fixture');process.exit(0)}
fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({event:'launch',pid:process.pid,at:Date.now()})+'\\n');
console.log('SYNTHETIC-CLI-READY');
process.stdin.resume();
const timer=setTimeout(()=>process.exit(0),20000);
const stop=()=>{clearTimeout(timer);fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({event:'stop',pid:process.pid,at:Date.now()})+'\\n');process.exit(0)};
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('SIGHUP',stop);
`, { mode: 0o700 });
const packId = 'local.lifecycle-fixture', providerId = 'lifecycle-fixture';
fs.mkdirSync(path.join(packRoot, packId));
fs.writeFileSync(path.join(packRoot, packId, 'provider-pack.json'), JSON.stringify({
  schemaVersion: 1, id: packId, label: 'Synthetic lifecycle fixture', version: '1',
  profiles: [{ id: providerId, label: 'Synthetic CLI', harness: 'generic-cli',
    backend: { id: 'fixture', label: 'No provider' }, command: { bin: 'wanigan-fixture-agent' }, headless: 'none',
    capabilities: { hooks: 'unsupported', 'headless.json': 'unsupported' } }],
}, null, 2));
for (const args of [['init', '--initial-branch=main'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
  const result = spawnSync('/usr/bin/git', ['-C', project, '-c', 'core.hooksPath=/dev/null', ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const initial = new DatabaseSync(path.join(profile, 'wanigan.db'));
initial.exec('CREATE TABLE settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);');
for (const key of ['hooks', 'telemetry', 'status_line', 'notifications', 'archive_transcripts']) {
  initial.prepare('INSERT INTO settings(k,v) VALUES (?,?)').run(key, '0');
}
initial.close();
const bootstrap = path.join(directory, 'main.cjs');
fs.writeFileSync(bootstrap, `const electron=require('electron');const {app,dialog}=electron;
// Encryption is outside this lifecycle probe. Keep both the application API
// and Chromium's cookie encryption away from the operator's real Keychain.
// The require facade exists only in this disposable fixture bootstrap.
const Module=require('node:module');const originalLoad=Module._load;
global.__fixtureEncryptionChecks=0;
const noCredentials={
  isAsyncEncryptionAvailable:async()=>{global.__fixtureEncryptionChecks++;return false},
  isEncryptionAvailable:()=>false,
  encryptStringAsync:async()=>{throw Error('Credential encryption is outside this fixture')},
  decryptStringAsync:async()=>{throw Error('Credential decryption is outside this fixture')},
  encryptString:()=>{throw Error('Credential encryption is outside this fixture')},
  decryptString:()=>{throw Error('Credential decryption is outside this fixture')}
};
const fixtureElectron=new Proxy(electron,{get(target,key){return key==='safeStorage'?noCredentials:Reflect.get(target,key)}});
Module._load=function(request,parent,isMain){return request==='electron'?fixtureElectron:originalLoad.call(this,request,parent,isMain)};
app.setPath('appData',${JSON.stringify(appData)});app.setPath('userData',${JSON.stringify(profile)});
// The fixture supplies deliberate approvals only for its inspected local pack
// and normal quit prompt. All application launch/finalization code is real.
dialog.showMessageBox=async(...args)=>{const options=args.at(-1);if(options.buttons?.includes('Trust this manifest digest'))return {response:1,checkboxChecked:false};if(process.argv.includes('--storage-maintenance')&&options.title==='Wanigan opened in recovery mode'&&options.buttons?.length===1&&options.buttons[0]==='Keep Wanigan open')return {response:0,checkboxChecked:false};throw Error('Unexpected fixture dialog: '+options.title)};
dialog.showMessageBoxSync=(options)=>{if(options.buttons?.includes('Stop agents and quit'))return 1;throw Error('Unexpected fixture sync dialog: '+options.title)};
dialog.showOpenDialog=async(...args)=>{const title=args.at(-1).title;if(title==='Add a project')return {canceled:false,filePaths:[${JSON.stringify(project)}]};if(title==='Check a Wanigan backup')return {canceled:false,filePaths:[${JSON.stringify(backupDirectory)}]};throw Error('Unexpected fixture folder picker: '+title)};
dialog.showSaveDialog=async(...args)=>{const title=args.at(-1).title;if(title!=='Back up Wanigan’s record')throw Error('Unexpected fixture save picker: '+title);return {canceled:false,filePath:${JSON.stringify(backupDirectory)}}};
dialog.showErrorBox=(title,detail)=>{console.error(title,detail);app.exit(2)};
require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`);
const executablePath = path.join(root, process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' : 'node_modules/electron/dist/electron');
const checks = [], errors = [];
let application;
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await pause(30);
  }
}
async function open({ maintenance = false } = {}) {
  const app = await _electron.launch({ executablePath,
    args: [bootstrap, `--user-data-dir=${profile}`, '--use-mock-keychain', ...(maintenance ? ['--storage-maintenance'] : [])], env });
  application = app;
  app.process().stderr.on('data', buffer => errors.push(buffer.toString()));
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.waitForFunction(() => Boolean(window.wanigan?.startup));
  await until(() => page.evaluate(async phase => (await window.wanigan.startup.status()).phase === phase, maintenance ? 'recovery' : 'ready'),
    maintenance ? 'native maintenance startup' : 'native services ready');
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  const encryptionChecks = await app.evaluate(() => global.__fixtureEncryptionChecks);
  if (maintenance) assert.equal(encryptionChecks, 0, 'Maintenance startup must not initialize credential encryption.');
  else assert(encryptionChecks > 0, 'Normal startup must exercise the fixture encryption boundary.');
  return { app, page };
}
// page.evaluate has no timeout of its own, so an IPC call that never settles
// would hang the probe instead of failing it with the app's stderr.
function bounded(promise, label, ms = 45_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(timer));
}
async function quit(app) {
  const closed = app.waitForEvent('close', { timeout: 15000 });
  await app.evaluate(({ app }) => { app.quit(); }); await closed;
}
try {
  let opened = await open(); application = opened.app;
  const { page } = opened;
  const manifest = await page.evaluate(id => window.wanigan.providerPacks.inspectManifest(id), packId);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  await page.evaluate(({ id, digest }) => window.wanigan.providerPacks.trustManifest(id, digest), { id: packId, digest: manifest.sha256 });
  await page.evaluate(id => window.wanigan.providerPacks.setEnabled(id, true), packId);
  const selected = await page.evaluate(() => window.wanigan.projects.pick());
  assert(selected); assert.equal(selected.path, project);
  const startup = await page.evaluate(() => window.wanigan.startup.retry());
  assert.equal(startup.phase, 'ready', JSON.stringify(startup));
  const session = await bounded(page.evaluate(input => window.wanigan.sessions.create(input), { providerId, projectId: selected.id }), 'sessions:create');
  await until(() => page.evaluate(async id => (await window.wanigan.sessions.scrollback(id)).includes('SYNTHETIC-CLI-READY'), session.id), 'synthetic CLI output');
  assert(fs.existsSync(marker));
  const launched = JSON.parse(fs.readFileSync(marker, 'utf8').trim().split('\n')[0]);
  assert.equal(launched.event, 'launch');
  checks.push('A trusted isolated generic-cli manifest launched the synthetic CLI through production IPC and a real PTY.');
  await quit(application); application = null;
  assert.throws(() => process.kill(launched.pid, 0), /ESRCH/);
  const saved = new DatabaseSync(path.join(profile, 'wanigan.db'), { readOnly: true });
  const recorded = saved.prepare('SELECT id,ended_at,exit_code FROM session_log WHERE id=?').get(session.id);
  saved.close(); assert(recorded); assert(recorded.ended_at !== null);
  checks.push('Normal Electron quit requested deliberate synthetic-agent termination and completed the production drain.');
  opened = await open(); application = opened.app;
  const active = await opened.page.evaluate(() => window.wanigan.sessions.list());
  assert.equal(active.filter(row => row.status === 'running' || row.status === 'starting').length, 0);
  // Generic CLI has no conversation id and is intentionally absent from the
  // resumable-conversation list. Verify its canonical execution row directly.
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'launch').length, 1);
  checks.push('Reopen retained the completed session record with no live session and no repeated CLI launch.');
  const recovery = await opened.page.evaluate(() => window.wanigan.recovery.inspect());
  assert(!recovery.observations.some(row => row.operationId === session.id));
  checks.push('Graceful completion left no unresolved checkout claim for the synthetic session.');
  await quit(application); application = null;
  const reopened = new DatabaseSync(path.join(profile, 'wanigan.db'), { readOnly: true });
  assert.deepEqual(reopened.prepare('SELECT id,ended_at,exit_code FROM session_log WHERE id=?').get(session.id), recorded);
  reopened.close();
  opened = await open({ maintenance: true }); application = opened.app;
  const maintenanceStartup = await opened.page.evaluate(() => window.wanigan.startup.status());
  assert.equal(maintenanceStartup.phase, 'recovery');
  assert.match(maintenanceStartup.message, /storage maintenance without background services or credentials/);
  // One keypress did not reliably open Settings here: two runs in five failed
  // on an unchanged checkout, with the app healthy, no page error, and the
  // maintenance alert ("Esc closes") on screen. That alert taking the keypress
  // is the likely cause and was not measured. Close it and press again rather
  // than trusting one keypress; six of six runs passed with this loop.
  const settingsHeading = opened.page.getByRole('heading', { name: 'Settings', exact: true });
  for (let attempt = 0; attempt < 5 && !(await settingsHeading.isVisible()); attempt++) {
    await opened.page.keyboard.press('Escape');
    await opened.page.evaluate(() => document.activeElement?.blur());
    await opened.page.keyboard.press('Meta+,');
    await settingsHeading.waitFor({ timeout: 3000 }).catch(() => {});
  }
  await settingsHeading.waitFor();
  await opened.page.locator('#settings-tab-backup').click();
  await opened.page.getByRole('heading', { name: 'Restore a backup', exact: true }).waitFor();
  await opened.page.keyboard.press('Meta+Shift+Y');
  await opened.page.getByRole('heading', { name: 'Recovery', exact: true }).waitFor();
  const maintenanceRecovery = await opened.page.evaluate(() => window.wanigan.recovery.inspect());
  assert.equal(maintenanceRecovery.unavailable, undefined, JSON.stringify(maintenanceRecovery));
  assert(!maintenanceRecovery.observations.some(row => row.operationId === session.id));
  const backup = await opened.page.evaluate(() => window.wanigan.backup.create());
  assert(backup); assert.equal(backup.dir, backupDirectory);
  const inspected = await opened.page.evaluate(() => window.wanigan.backup.inspect());
  assert(inspected); assert.equal(inspected.dir, backupDirectory); assert.deepEqual(inspected.problems, []);
  assert.equal(inspected.database.sha256, backup.database.sha256);
  checks.push('Fresh --storage-maintenance skipped credentials, kept Backup/Recovery views reachable and exposed real Recovery inspection plus a verified temporary Backup through production IPC.');
  await assert.rejects(opened.page.evaluate(input => window.wanigan.sessions.create(input), { providerId, projectId: selected.id }), /storage maintenance/);
  await assert.rejects(opened.page.evaluate(() => window.wanigan.batch.refreshModels()), /storage maintenance/);
  await assert.rejects(opened.page.evaluate(() => window.wanigan.providers.list()), /storage maintenance/);
  checks.push('Maintenance refused execution, network model refresh and provider discovery IPC before their handlers ran.');
  const retriedMaintenance = await opened.page.evaluate(() => window.wanigan.startup.retry());
  assert.equal(retriedMaintenance.phase, 'recovery');
  assert.match(retriedMaintenance.message, /storage maintenance without background services or credentials/);
  assert.equal(await application.evaluate(() => global.__fixtureEncryptionChecks), 0);
  assert.equal((await opened.page.evaluate(() => window.wanigan.sessions.list())).length, 0);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'launch').length, 1);
  checks.push('Startup retry preserved maintenance mode with zero credential calls, no live sessions and no repeated synthetic CLI launch.');
  await quit(application); application = null;
  console.log(JSON.stringify({ provenance: 'Real production Electron/main/preload and PTY; synthetic CLI; fixture dialog approvals; unavailable credential-encryption test double and Chromium mock keychain; no provider calls', checks, fixtureRoot: directory, providerPacksDir: packRoot }, null, 2));
} catch (error) {
  console.error(errors.join('').slice(-12000)); throw error;
} finally {
  if (application) await application.close().catch(() => {});
  fs.rmSync(directory, { recursive: true, force: true });
}
