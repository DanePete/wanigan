// Read-only: build the Skills and MCP listings against the owner's real home
// and print only counts and server names. Nothing is written outside a
// temporary folder: no core starts, no CLI runs, Wanigan's own database is
// opened read-only for the list of open projects, and no value, URL, command
// or path from a config file is printed.
//   node scripts/run-electron-node.mjs scripts/real-listing.ts
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/core/accounts.ts';
import { Board } from '../src/core/board.ts';
import { Bus, type Ctx } from '../src/core/context.ts';
import { openDatabase } from '../src/core/db.ts';
import { Mcp } from '../src/core/mcp.ts';
import { Skills } from '../src/core/skills.ts';
import type { Sessions } from '../src/core/sessions.ts';

const home = homedir();
const scratch = mkdtempSync(join(tmpdir(), 'wg-real-listing-'));
try {
  const db = openDatabase(join(scratch, 'wanigan.db'));
  const ctx: Ctx = { db, now: Date.now, emit: new Bus().emit };
  const board = new Board(ctx);
  const accounts = new Accounts(ctx, {
    home,
    prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }),
    usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'not read' }),
  });
  accounts.discover();

  // The projects open in the owner's Wanigan 2, read-only.
  const real = join(home, 'Library', 'Application Support', 'Wanigan 2', 'wanigan.db');
  let opened = 0;
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3') as new (f: string, o: object) => { prepare(s: string): { all(): unknown[] }; close(): void };
    const source = new Database(real, { readonly: true, fileMustExist: true });
    for (const row of source.prepare('SELECT path, name FROM projects WHERE archived_at IS NULL').all() as { path: string; name: string }[]) {
      try { board.addProject({ path: row.path, name: row.name }); opened++; } catch { /* folder gone */ }
    }
    source.close();
  } catch {
    console.log('(No Wanigan 2 database to read open projects from.)');
  }

  const all = accounts.list();
  console.log(`Accounts: ${all.filter((a) => a.provider === 'claude').length} Claude Code, ${all.filter((a) => a.provider === 'codex').length} Codex. Open projects: ${opened}.`);

  const skills = new Skills(ctx, accounts, board, { home, dataDir: scratch }).list();
  const total = skills.groups.reduce((n, g) => n + g.skills.length, 0);
  console.log(`\nSkills: ${total} in ${skills.groups.length} places (${skills.empty.length} places looked in were empty).`);
  for (const g of skills.groups) {
    console.log(`  ${g.agent.padEnd(6)} ${g.source.padEnd(8)} ${`${g.title}${g.account ? ` (${g.account})` : ''}`.padEnd(44)} ${String(g.skills.length).padStart(3)}`);
  }
  const off = skills.groups.flatMap((g) => g.skills).filter((s) => s.enabled === false).length;
  if (off) console.log(`  (${off} of them belong to plugins that are switched off)`);

  // Sessions are only needed to open a terminal, which this never does.
  const mcp = new Mcp(ctx, accounts, board, null as unknown as Sessions, { home, neutralDir: scratch }).list();
  const servers = mcp.groups.flatMap((g) => g.servers);
  console.log(`\nMCP servers: ${servers.length} in ${mcp.groups.length} places (${mcp.empty.length} places looked in had none).`);
  for (const g of mcp.groups) {
    const names = g.servers.map((s) => `${s.name}${s.scope === 'user' ? '' : ` [${s.scope}]`}${s.enabled ? '' : ' (off)'}`);
    console.log(`  ${g.agent.padEnd(6)} ${`${g.title}${g.account ? ` (${g.account})` : ''}`.padEnd(40)} ${names.join(', ') || '—'}${g.note?.startsWith('Wanigan could not read') ? '  [unreadable]' : ''}`);
  }
  const hidden = servers.reduce((n, s) => n + s.env.filter((e) => e.redacted).length + s.headers.filter((h) => h.redacted).length + (s.target.includes('•••') ? 1 : 0), 0);
  console.log(`  Values hidden as secrets: ${hidden}.`);
  db.close();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
