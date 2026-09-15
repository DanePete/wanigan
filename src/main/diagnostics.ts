import { app, dialog, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { allSettings } from './settings';
import { providerPackRegistry } from './providers';
import { readPreflight } from './preflight';
import { redactCredentials } from './redact';
import { configFilesReport } from './config-files-audit';
import {
  EXCLUDED, isBundleName, lastLines, scrubForDiagnostics, type DiagnosticsFile, type DiagnosticsPreview,
} from '../shared/diagnostics';

const exec = promisify(execFile);

/**
 * Export diagnostics: a zip the operator saves on purpose.
 *
 * Built twice by design — once for the preview, which lists every file with
 * its size, and again at save, which refuses unless it produced the same file
 * names the operator was shown. What is inside is counts and shapes: the app
 * and schema, redacted settings, provider profiles and pack digests with no
 * environment values, recent gate results as command and exit code with no
 * output, the first-run checklist, table row counts with no rows, and the tail
 * of Wanigan's own main log if one exists (Wanigan writes none today, and the
 * bundle says so rather than inventing one).
 */

type Built = { name: string; describes: string; content: string };

const LOG_LINES = 500;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function scrub(value: unknown): unknown {
  return scrubForDiagnostics(value, os.homedir(), redactCredentials);
}

function tableFacts(): { counts: Record<string, number>; fingerprint: string; userVersion: number } {
  const d = db();
  const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name);
  const counts: Record<string, number> = {};
  const shape: string[] = [];
  for (const name of tables) {
    // Names come from sqlite_master, never from input; quoted all the same.
    const quoted = `"${name.replace(/"/g, '""')}"`;
    try { counts[name] = (d.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number }).n; }
    catch { counts[name] = -1; }
    const columns = (d.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string }[]).map((c) => c.name).sort();
    shape.push(`${name}(${columns.join(',')})`);
  }
  const userVersion = Number((d.pragma('user_version', { simple: true }) as number) ?? 0);
  return { counts, fingerprint: createHash('sha256').update(shape.join('\n')).digest('hex'), userVersion };
}

function mainLogPath(): string | null {
  for (const candidate of [path.join(app.getPath('logs'), 'main.log'), path.join(app.getPath('userData'), 'logs', 'main.log')]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* absent */ }
  }
  return null;
}

async function build(): Promise<Built[]> {
  const facts = tableFacts();
  const files: Built[] = [];
  files.push({
    name: 'app.json',
    describes: 'Wanigan, Electron, Node and macOS versions, and the database schema fingerprint',
    content: json({
      wanigan: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
      platform: process.platform, arch: process.arch, osRelease: os.release(),
      schema: {
        userVersion: facts.userVersion,
        tables: Object.keys(facts.counts).length,
        // Migrations are additive and unnumbered, so the schema's identity is
        // the hash of every table and its column names.
        fingerprintSha256: facts.fingerprint,
      },
      generatedAt: new Date().toISOString(),
    }),
  });
  files.push({
    name: 'settings.redacted.json',
    describes: 'Settings, with every secret-named value replaced and the home folder shown as ~',
    content: json(scrub(allSettings())),
  });
  files.push({
    name: 'providers.json',
    describes: 'Provider packs and profiles with manifest and adapter digests; no environment values or credentials',
    content: json({
      packs: scrub(providerPackRegistry.listPacks({ includeRemoved: true }).map((pack) => ({
        id: pack.id, label: pack.label, version: pack.version, source: pack.source, status: pack.status,
        manifestSha256: pack.manifestSha256 ?? null, trustedManifestSha256: pack.trustedManifestSha256 ?? null,
        adapterSha256: pack.adapterSha256 ?? null, trustedAdapterSha256: pack.trustedAdapterSha256 ?? null,
      }))),
      profiles: scrub(providerPackRegistry.listProfiles({ includeDisabled: true }).map((profile) => ({
        id: profile.id, packId: profile.packId, packVersion: profile.packVersion, label: profile.label,
        harness: profile.harness, backendId: profile.backend.id, bin: profile.command.bin, headless: profile.headless ?? null, enabled: profile.enabled,
      }))),
    }),
  });
  const reviews = db().prepare('SELECT started_at, ended_at, status, results_json FROM review_runs ORDER BY started_at DESC LIMIT 20')
    .all() as { started_at: number; ended_at: number | null; status: string; results_json: string }[];
  files.push({
    name: 'gate-results.json',
    describes: 'The last 20 review gate runs: each command and exit code, never its output',
    content: json({
      note: reviews.length ? null : 'No review gate has run on this Mac, so there are no gate results to include.',
      runs: reviews.map((row) => {
        let results: { command?: unknown; exitCode?: unknown; durationMs?: unknown }[] = [];
        try { results = JSON.parse(row.results_json) as typeof results; } catch { results = []; }
        return {
          startedAt: new Date(row.started_at).toISOString(), status: row.status,
          commands: results.map((r) => ({ command: typeof r.command === 'string' ? redactCredentials(r.command).slice(0, 300) : null, exitCode: r.exitCode ?? null, durationMs: r.durationMs ?? null })),
        };
      }),
    }),
  });
  let preflight: unknown;
  try { preflight = await readPreflight(); } catch (error) { preflight = { unreadable: error instanceof Error ? error.message : String(error) }; }
  files.push({ name: 'preflight.json', describes: 'The first-run checklist as Wanigan reads it now', content: json(scrub(preflight)) });
  files.push({ name: 'table-counts.json', describes: 'Row counts for every table; no row contents', content: json(facts.counts) });
  let configFiles: unknown;
  try { configFiles = configFilesReport(); } catch (error) { configFiles = { unreadable: error instanceof Error ? error.message : String(error) }; }
  files.push({ name: 'config-files.json', describes: 'Which state files parse, entries the loader refuses and why, and the variable names blanked for MCP servers', content: json(scrub(configFiles)) });
  const log = mainLogPath();
  if (log) {
    let text = '';
    try { text = fs.readFileSync(log, 'utf8'); } catch { text = ''; }
    files.push({ name: 'main-log.txt', describes: `The last ${LOG_LINES} lines of Wanigan’s main log, redacted`, content: redactCredentials(lastLines(text, LOG_LINES)).split(os.homedir()).join('~') });
  }
  files.push({
    name: 'readme.txt',
    describes: 'What this bundle is, and what it leaves out',
    content: [
      'Wanigan diagnostics bundle.',
      '',
      'Contents: ' + ['app.json', 'settings.redacted.json', 'providers.json', 'gate-results.json', 'preflight.json', 'table-counts.json', 'config-files.json', ...(log ? ['main-log.txt'] : [])].join(', ') + '.',
      log ? '' : 'Wanigan writes no main log file today, so none is included.',
      '',
      'Deliberately not included: ' + EXCLUDED.join('; ') + '.',
      '',
    ].join('\n'),
  });
  return files.filter((file) => isBundleName(file.name));
}

export async function previewDiagnostics(): Promise<DiagnosticsPreview> {
  const files = await build();
  return {
    files: files.map((f): DiagnosticsFile => ({ name: f.name, describes: f.describes, bytes: Buffer.byteLength(f.content) })),
    excluded: [...EXCLUDED],
  };
}

/**
 * Save the bundle through the native dialog. `expectedNames` is the list the
 * preview showed; a different list is refused, so what is saved is what was
 * seen. Returns the saved path, or null when the operator cancelled.
 */
export async function saveDiagnostics(win: BrowserWindow | null, expectedNames: unknown, targetForTest?: string): Promise<string | null> {
  if (!Array.isArray(expectedNames) || !expectedNames.every((n) => typeof n === 'string')) {
    throw new Error('Preview the bundle first, so the files saved are the files you saw.');
  }
  const files = await build();
  const names = files.map((f) => f.name);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error('The bundle’s file list changed since the preview. Preview it again before saving.');
  }
  let target = targetForTest ?? null;
  if (!target) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const picked = await (win
      ? dialog.showSaveDialog(win, { title: 'Export diagnostics', defaultPath: path.join(app.getPath('desktop'), `wanigan-diagnostics-${stamp}.zip`), filters: [{ name: 'Zip archive', extensions: ['zip'] }] })
      : dialog.showSaveDialog({ title: 'Export diagnostics', defaultPath: `wanigan-diagnostics-${stamp}.zip`, filters: [{ name: 'Zip archive', extensions: ['zip'] }] }));
    if (picked.canceled || !picked.filePath) return null;
    target = picked.filePath.endsWith('.zip') ? picked.filePath : `${picked.filePath}.zip`;
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-diagnostics-'));
  const folder = path.join(staging, path.basename(target, '.zip'));
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
    for (const file of files) fs.writeFileSync(path.join(folder, file.name), file.content, { mode: 0o600 });
    // ditto writes a Finder-compatible zip and is part of macOS.
    const tmpZip = `${target}.partial-${process.pid}`;
    await exec('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', folder, tmpZip]);
    fs.renameSync(tmpZip, target);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
