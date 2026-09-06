# Wanigan — 80-phase audit remediation

**Status file. Update the checkboxes as waves land.** This exists so the work can be
picked up by someone (or something) with none of the originating context.

Last updated: 2026-09-06 ~00:40, overnight run. 979 smoke assertions, all pushed.

---

## Where this came from

A 16-dimension read-only audit of the repository raised 192 findings. Each was then
handed to a separate agent told to *refute* it, which killed 93. The 99 survivors were
confirmed against the actual code. Twenty were closed in the first sitting; the
remaining 79 were designed into phases by a planner, and every cluster's plan was then
critiqued by a second agent that had to find what would break. That produced **80
phases**, packed into **16 waves**.

Artifacts, in the session scratchpad
(`/private/tmp/claude-501/-Users-dane-Projects-drupal-wanigan/49accb3c-3eae-4691-b738-218c1666d8f4/scratchpad/`):

| file | what it holds |
|---|---|
| `confirmed.json` | all 99 confirmed findings with evidence, impact, fix and the adversarial correction |
| `remaining.json` / `remaining.txt` | the 79 that were still open when planning started, indexed `[0]`–`[78]` |
| `waves.json` | the 80 phases, packed into 16 file-disjoint waves — **the machine-readable plan** |
| `wave.sh` | snapshot / diff / revert / check harness (see below) |
| `snaps/` | per-wave tarballs of the tracked tree |

If the scratchpad is gone, this document is the plan.

---

## Overnight run — read this first if you are picking up

The operator went to bed and asked for continuous work. State at handoff:

**Committed and pushed** on `task-graphs-and-accounts`, 923 assertions green:
the shared renderer frame, the sidebar, the CLI parser fixes, cost provenance,
seven dialogs on one contract, three waves of audit phases, the iPad transport
(Wanigan drives Tailscale itself + a verified QR encoder), the iPad's three
connection states, the sleep blocker, and goal autopilot armable from Control.

**In flight when this was written:** the `mobile.ts` split (one large refactor,
18 files, everything iPad depends on it), and four desktop phases.

**Next, in order:**
1. Land the split. If its agent dies mid-move, FINISH IT BY HAND — that has
   happened four times today and the partial work has been good every time.
2. Then `scratchpad/ipad-waves.json`: 26 menu phases in 10 waves, 3–4 at a time.
   Ten destinations earn a phone surface (Fleet, Agent, Goals, Batches, Runs,
   Spend, Learning, Scout, Git, Device); Skills, Context, Plugins and full
   Settings deliberately do not, and the phone says so rather than omitting them.
3. Then re-run the 20-agent research pass (`wanigan-deep-research-2`), which was
   killed at 3/20.

**The failure mode that has cost four runs today:** a background Workflow is
killed whenever anything interrupts, and then reports "started, N results, no
completion record" — which looks identical to still-running. NEVER wait with a
blocking `TaskOutput`. Poll the journal from Bash, and check the newest
`agent-*.jsonl` mtime: no activity for >5 minutes means dead, not slow.

**The other discipline that matters:** build agents never edit `src/main/smoke*.ts`.
They return the assertion as code plus an anchor line, and it is applied centrally
between waves. Thirty phases wanted `smoke3.ts`; serialising on it would turn
every wave into a queue.


## The rule that makes this work

**Within one wave, no two phases touch the same file.** That is what lets seven agents
build concurrently without clobbering each other. The packing already accounts for it.

Two files are deliberately excluded from that packing and reserved:

- **`src/main/smoke*.ts`** — thirty phases wanted to add assertions to `smoke3.ts`.
  Serialising on it would have turned seven-wide waves into a queue. Build agents are
  told **not to edit any smoke file**; they return the assertion as code plus an anchor
  line, and it is applied centrally between waves.
- **`src/renderer/src/App.tsx`** — contended by many phases. At most one phase per wave
  may touch it.

---

## Running a wave

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
SP=/private/tmp/claude-501/-Users-dane-Projects-drupal-wanigan/49accb3c-3eae-4691-b738-218c1666d8f4/scratchpad

$SP/wave.sh snap w<N>      # before: tarball the tracked tree
# ... run the wave's agents, one per phase, each owning only its own files ...
$SP/wave.sh diff w<N>      # after: exactly which files moved
$SP/wave.sh check          # typecheck -> style gate -> smoke
```

`wave.sh revert w<N> <file>…` restores named files from a snapshot. That is the recovery
path when an agent dies mid-edit, which has happened twice: agents hit a session limit
and left the tree half-changed, and without the snapshot there was no way to tell their
partial work from everything else that moved in the same window.

The workflow script that drives a wave is at
`.../workflows/scripts/wanigan-wave-wf_e06499b6-1ad.js`. Re-invoke it with a new `args`
array — one object per phase, each `{title, cluster, effort, files, goal, approach,
migration, risk, verify}` — taken from `waves.json`.

Build the args for wave N (1-indexed) like this. Note `_own`, not `files`: it is the
phase's file list with the smoke files already removed, which is what the agent is
allowed to touch.

```bash
python3 -c "
import json
N = 3   # the wave you are about to run
w = json.load(open('$SP/waves.json'))[N-1]
out = []
for p in w:
    out.append({
        'title': p['title'], 'cluster': p['cluster'], 'effort': p['effort'],
        'files': p['_own'],
        'goal': p['goal'][:600], 'approach': p['approach'][:1400],
        'migration': (p.get('migration') or 'none')[:300],
        'risk': (p.get('risk') or '')[:500], 'verify': (p.get('verify') or '')[:500],
    })
print(json.dumps(out))
"
```

Then pass that JSON as the Workflow tool's `args`.

**Go wide.** The wave numbering in `waves.json` is a conservative packing capped at seven.
The only real constraint is file-disjointness, so more phases can usually run at once than
one wave holds — and a second workflow can be launched *beside* a running one, as long as
its phases touch none of the files the first is holding. Compute that set rather than
guessing:

```bash
python3 -c "
import json
waves = json.load(open('$SP/waves.json'))
INFLIGHT = 3          # index of the wave currently running
DONE = 3              # waves already landed
inflight = {f for p in waves[INFLIGHT] for f in p['_own']}
done = {p['title'] for w in waves[:DONE] for p in w}
bytitle = {p['title']: p for w in waves for p in w}
pick, used = [], set(inflight)
for p in [q for w in waves[INFLIGHT+1:] for q in w]:
    fs = set(p['_own'])
    if not fs or (fs & used): continue
    if any(d in bytitle and d not in done and d not in {q['title'] for q in pick}
           for d in (p.get('dependsOn') or [])): continue
    pick.append(p); used |= fs
print(len(pick), 'can run right now')
"
```

Agents queue past the concurrency cap (min(16, cpus−2) per workflow) and all still
complete, so a wide batch costs wall-clock, not correctness.

**If the workflow dies mid-wave** — it has, twice, on session limits — the partial edits
are still on disk and have been good quality every time. Do not discard them reflexively.
Run `wave.sh diff`, read each changed file, finish what is half-done, and only revert
what is actually incoherent. The journal at
`.../subagents/workflows/<runId>/journal.jsonl` holds one `{"type":"result",…}` line per
agent that finished, including the assertions it wanted; agent prompts are recoverable
from the sibling `agent-<id>.jsonl` files when the labels are missing.

### After every wave, in order

1. `wave.sh diff` — confirm only the expected files moved.
2. Apply the returned assertions to the smoke files yourself.
3. `wave.sh check` — all three must pass.
4. Ratchet `scripts/check-renderer-style.cjs` baselines down if counts dropped:
   `node scripts/check-renderer-style.cjs --print-baseline`.
5. Commit. One commit per wave is fine; the message should say what is now true, not
   which files moved.

---

## Non-negotiables for any agent doing this work

Read `CLAUDE.md` — it is binding. The parts that get violated most:

- **Say the true thing.** Never present an estimate as a measurement. A view that
  renders its initial state after a failed read does not merely fail to know something,
  it asserts the opposite. Prefer an honest unsupported state to an invented one.
- **Trust boundary.** Privileged work in `src/main/`; the renderer reaches it only
  through typed preload APIs; all renderer input is untrusted until validated in main.
- **Migrations are additive.** A column added later is nullable, and a row written
  before it existed reads as *unknown*, never as a value.
- **Status is glyph + word before colour.** Colour is never the only channel.
- **The PTY owns its keystrokes.** Nothing animates near a live terminal.
- **Renderer style gate.** Roots on `.pane` with `PageHead`; composes the primitives in
  `src/renderer/src/components/bits.tsx`; dialogs use `components/useDialog.ts`; no
  `<style>` in TSX; `styles/*.css` spells no colour and no literal size or duration.
  `scripts/check-renderer-style.cjs` enforces it and its baselines only ratchet **down**.

Verification is five steps, `npm test`: `typecheck`, `test:renderer-style`,
`test:package-hooks`, `test:local-install`, `smoke`. Node 22.23.2 is required.

The smoke suite runs in a real Electron main process and mixes behavioural assertions
with assertions about **renderer source strings** (that process has no renderer). So
renaming a renderer symbol can break a test even when behaviour is identical. Grep
`src/main/smoke*.ts` before any rename.

---

## Progress

- [x] **Wave 1** — 7/7 done. TTL refresh on delivered knowledge; golden set as a batch
      source; Runs waits for its first read; the autopilot slot row removed; Usage window
      and Fleet tile say what they count; Control copies a goal id not a dead URL; the
      follow-account label describes the fallback.
- [x] **Wave 2** — 7/7. ps locale pinned and three liveness states separated; autopilot
      halt reason as a typed field plus a budget an existing goal can be given; task cards
      name their prerequisites; the ambient credential strip reaches the headless path;
      openInEditor confines both exits; one provider tint table; the composer's skill menu
      announces itself.
- [x] **Wave 3** — 7/7 (six built, one smoke-only folded in). Default docket plan shared
      between processes; viewMemory made safe to consume; Git's diff pane reconciled with
      the status each action returns; composer drafts bounded to one pruned key; the Usage
      daily chart named and tabulated; Control remembers its status filter.
- [ ] Wave 4 (7) · [ ] Wave 5 (7) · [ ] Wave 6 (7)
- [ ] Wave 7 (7) · [ ] Wave 8 (7) · [ ] Wave 9 (7) · [ ] Wave 10 (6) · [ ] Wave 11 (1)
- [ ] Wave 12 (4) · [ ] Wave 13 (2) · [ ] Wave 14 (2) · [ ] Wave 15 (1) · [ ] Wave 16 (1)

---

## The largest items

Three phases are marked `large` and deserve their own attention rather than being run
alongside six others:

- **Give transcript turns a real table so `session_id` is indexed** (wave 8). Archiving
  one transcript currently full-scans the FTS index because `session_id` is `UNINDEXED`
  in fts5.
- **Read the model catalogue in main, once, for every backend** (wave 10). The launch
  dialog ships hardcoded Anthropic aliases and separate hardcoded GLM/DeepSeek lists
  while live catalogue fetchers exist. The requirement is to **intersect** the live list
  with the profile's declared choices — not simply render `field.options`, which would
  regress Codex, whose declared choices are static while the live catalogue filters
  efforts per model.
- **Design a goal's task graph in the Control create card** (wave 22 in the original
  packing, wave 12 here). The docket task graph is fully validated in main but no UI can
  build one, so every docket gets the same fixed four phases.

**`Show sessions started outside Wanigan in Fleet, read-only`** is the single most
valuable remaining item and is not marked large. `src/main/observed.ts` is 465 lines of
finished, carefully-reasoned code with three IPC channels and zero renderer surface — the
feature cannot be switched on at all. Its module comment is worth reading in full before
building the UI: it explains why the rows stay out of the policy gate, the attention
queue and the spend roll-up, and it already exports `OBSERVE_ONLY_NOTICE`, "the sentence
the UI has to carry".

---

## The iPad programme

Started 2026-09-05, after the operator said the iPad should become their primary device and
that requiring Tailscale "is not a SaaS product".

### The constraint, stated once

The Mac is the engine and always will be: Wanigan spawns PTYs, owns the SQLite evidence, and
runs Claude Code and Codex against real checkouts. The iPad can only ever be a remote control
for that Mac. "iPad as primary" therefore means **reliable remote access to the Mac from
anywhere**, not a second place the work happens.

Reaching a machine behind NAT from anywhere has exactly three mechanisms: a mesh VPN, a relay
someone operates, or port forwarding. Port forwarding is dead under CGNAT. A relay is a cloud
tier, which `CLAUDE.md` forbids. That leaves the mesh VPN — so Tailscale is not the problem,
**exposing it as a CLI command and a URL field is the problem.** The fix is to drive it from
Wanigan: detect it, run `tailscale serve` ourselves, read the URL back, show a QR code.

### Why not just serve on the LAN

Considered and rejected as the primary path. iOS Safari treats plain HTTP on a LAN address as
an insecure context: no Home Screen install, no service worker, no WebCrypto — and a bearer
token plus live terminal bytes would cross Wi-Fi in clear. Real TLS needs a certificate the
iPad trusts, which means shipping our own CA and a profile install. That is worth doing later
for at-desk use, but it does not serve "carry it everywhere", which is the actual requirement.

### The client question

- **PWA (what ships today)** — iOS 16.4+ supports Web Push for Home Screen apps, so
  notifications are reachable without a second codebase. This is the right next step.
- **Native Swift** — the real answer if the iPad becomes the daily driver: Stage Manager,
  keyboard shortcuts, Split View, Pencil, and no certificate problem at all. It talks to the
  same endpoint and the same pairing, so the transport work below is not thrown away.
- **React Native** — only if Android ever matters. For an iPad-first tool it buys the App
  Store and costs the platform's best parts.

### Open question, deliberately not decided

If "SaaS product" ever means other people paying to run agents, the agents would run on rented
compute rather than the customer's Mac. That contradicts the local-first premise this whole
codebase is built on. Decide it deliberately; do not drift into it.

### Transport phases (in flight)

1. **Drive Tailscale from Wanigan** — `src/main/tailnet.ts`. Five honest states (absent,
   logged-out, ready, serving, error), argv never a shell string, `tailscale serve` run by us.
2. **Generate the pairing QR in main** — `src/shared/qr.ts`, pure and dependency-free. This
   repo ships three runtime dependencies and that leanness is deliberate.
3. **Make the phone setup a QR, not a page of instructions** — the Settings panel shows one
   state-appropriate action; the manual URL and CLI command move behind an Advanced disclosure.

Twenty view phases (navigation, accounts and providers, Git, Explore, Manage, depth) are being
designed separately. The Git one is the interesting case: `mobile.ts` promises that no
filesystem paths reach the wire, and a Git surface is made of paths. That is a deliberate,
separately-consented widening of a stated promise — never a quiet relaxation of
`privacyFilterSnapshot`.


### Leaving the laptop at home

The operator's actual scenario: Mac at home, iPad on cellular. Tailscale handles the transport
for this without further work — that is the whole point of a mesh VPN. What does NOT work today
is everything around it, and none of it is transport:

- **macOS sleeps, and a sleeping Mac leaves the tailnet.** `grep -rn powerSaveBlocker src/main/`
  returns nothing: Wanigan has never held sleep off. Agents stop mid-turn and the iPad shows an
  empty fleet. Electron's `powerSaveBlocker.start('prevent-app-suspension')` is the mechanism,
  held while sessions are running or the dashboard is on, and **announced** — silently keeping a
  laptop awake is rude and drains a battery someone thought was idle.
- **A closed lid on battery sleeps regardless.** No software overrides that; it has to be plugged
  in. Wanigan can read the power source and say so before the operator walks away.
- **A reboot kills interactive sessions.** CLAUDE.md is explicit that a live PTY cannot survive a
  quit. Headless runs and schedules come back; interactive Claude Code sessions do not. Worth
  knowing at the desk, not from a coffee shop.

The feature this wants is a **leaving-your-desk readiness check**: one panel answering whether the
Mac is safe to walk away from — plugged in, sleep held, tailnet up, dashboard reachable, and what
would survive a restart.

Phases:
4. **Tell the iPad why the Mac is unreachable** — `src/main/mobile.ts`. Three connection states
   (connected / stale-with-age / never-connected), the empty-fleet claim gated on an observed
   successful poll, and a backed-off retry so a phone on cellular does not poll a sleeping Mac
   every two seconds.
5. **Hold the Mac awake while work is live** — new `src/main/awake.ts` + IPC. Blocked until the
   tailnet phase releases `src/main/index.ts`, `src/preload/index.ts` and `src/shared/types.ts`.
6. **The readiness check panel** — `Settings.tsx`. Blocked until the QR-panel phase releases it.


### Install is pending, deliberately

The last `npm run dist:mac:arm64:install` refused: "Wanigan is running (PID 37835) and
declined the graceful Quit request. No files were changed." That is the installer working
correctly — it will not clobber a live app.

I did NOT force-quit it. No agent PTYs were running (only Electron's own helpers), so it
would probably have been safe, but the app declining a quit is a signal to respect rather
than override while the operator is asleep. Everything is committed and pushed, so nothing
is lost by waiting.

**To pick this up:** quit Wanigan from its own menu, then `npm run dist:mac:arm64:install`.
Waves 1–4 of the iPad programme are in the repo but NOT yet in the installed bundle — the
running app is from 00:33 and carries the navigation but not Git, Spend, Manage or the
offline shell.


## Known traps

- **Packaging corrupts `node_modules`.** `electron-builder --mac` rebuilds native addons
  per target arch and can leave `node-pty` without build output. The `dist:mac*` scripts
  run `npm run rebuild` afterwards with `;` not `&&` so it runs on the failure path too.
  Symptoms of the failure are a smoke suite that hangs at 0% CPU.
- **`--dir` and `npx asar extract-file` overwrite the source `package.json`.** Snapshot
  it first.
- **GUI apps cannot be launched from a shell tool.** `open` reports success, the app
  writes its caches and exits, and that is *not* evidence the app is broken. Verify with
  tests. `scripts/shots-browser.mjs` renders the built renderer in plain Chromium with a
  stubbed bridge when you need to see a view; it must serve over http because the
  renderer ships a real CSP and `'self'` is opaque on `file://`.
- **Two git remotes.** `origin` is `DanePete/wanigan.git` and is correct. `archive` is
  the pre-scrub `foreman` repo — history was rewritten with `git filter-repo` to remove
  real client names, so the two share no ancestry. Push to `origin`.

---

## Full phase list

Everything below is generated from `waves.json`. Each entry carries the goal, the
approach the planner designed and the critic corrected, and what to assert.

### Wave 1 — 7 phases

- **Refresh the TTL of knowledge a launch actually delivered** `medium` · _honesty_
  - files: `src/main/learning/ledger.ts`, `src/main/learning-service.ts`, `src/main/sessions.ts`, `src/main/headless.ts`
  - goal: Every path that injects a briefing also extends the expiry of the derived items it injected, so a machine-derived item that keeps earning its place in a launch briefing stops self-quarantining on a 90-day clock nothing resets. Verified: only the headless Claude-with-hooks path refreshes (index.ts:867 → learning.briefingForContext → learning-service.ts:1177); the attended path (sessions.ts:31 impor
  - approach: Move the refresh down to the layer both launch sites already import, and make recording and refreshing one act.  1. src/main/learning/ledger.ts — beside recordSessionBriefing (defined at line 38), add `export const MACHINE_KNOWLEDGE_TTL_MS = 90 * 24 * 60 * 60 * 1000;` and move `refreshDeliveredKnowledgeTtl(entries: { itemId: string }[], at = Date.now()): void` here verbatim from learning-service.ts:699. Verified it needs nothing but `db()`, which ledger.ts imports at line 9, and that neither name is exported by any other module the barrel re-exports (`export * from './ledger'` at learning/inde
  - verify: In src/main/smoke4.ts, inside the '── compound · legibility ledger' block after the hook-pairing checks (~line 432), add: stamp an item that IS in `bounded.entries` with a near expiry — `db().prepare('UPDATE knowledge_items SET expires_at=? WHERE id=?').run(Date.now() + 60_000, budgetItem.item.id)` 
  - migration: none. refreshDeliveredKnowledgeTtl UPDATEs knowledge_items.expires_at only on rows that already have a non-null expiry, only when the stored expiry is earlier than the new one, and only where status='active' — so existing user data is untouched excep
- **Use a pinned golden set as the source of a new batch run** `medium` · _dead-subsystems_
  - files: `src/renderer/src/views/Batches.tsx`, `src/renderer/src/styles/batches.css`
  - goal: `evals.goldenSource` gets its first caller, so a pinned dataset can be replayed. Today a golden set is write-only: `saveGolden` works and the rows are stored, but the empty-state promise at Batches.tsx:2280 — "Pin them and a config from next month can be compared with one from today" — cannot be kept by anything in the app.
  - approach: All inside `src/renderer/src/views/Batches.tsx` plus one CSS rule. The file sits at its inline-style baseline of 206, so every addition uses an existing class (`btn bx-f`, `r`, `mono`, `faint`) or the one new one.  1. Generalise the builder seed at the top of the file: `type BuilderSeed = { kind: 'files'; projectId: string; root: string; paths: string[] } | { kind: 'golden'; goldenId: string; goldenName: string; rows: number; base: RunConfig; source: SourceConfig };` 2. In `export default function Batches(...)` (line 116): `const [goldenSeed, setGoldenSeed] = useState<Extract<BuilderSeed, { ki
  - verify: In the `── phase 17 · evals` block (smoke3:590-599), add a behavioural round-trip using direct inserts, the technique the suite already uses for the legacy schedule row at 1700: insert one `runs` row (`id, name, model, status, config_json, total_requests, created_at` — every NOT NULL column, verifie
- **Make Runs wait for its first read before saying nothing has run** `small` · _honesty_
  - files: `src/renderer/src/views/HeadlessRuns.tsx`
  - goal: The Runs view stops asserting "Nothing has run yet", a run count of 0, and "No run selected · start a fan-out" during the window before `headless.runs(50)` has returned, and stops asserting them forever when that read fails. A read sentinel makes "not read yet", "could not read" and "read, and it is empty" three different renderings.
  - approach: Verified: `runs` is read at exactly four sites (78, 326, 327/330, 343) plus written in `load`. Nothing else in the file touches it.  1. Line 44 → `const [runs, setRuns] = useState<HeadlessRun[] | null>(null);` 2. Line 78 → `const current = runs?.find((r) => r.id === selected) ?? null;` 3. `load` (109-113) is unchanged: `setRuns(next)` always writes an array, so the sentinel only ever holds before the first success. 4. Line 326, the history head count → `<span className="hr-count">{runs === null ? '—' : runs.length}</span>` — an em dash is "not read", never a claimed zero. 5. Lines 327-334, the
  - verify: `npm run typecheck` — the null union forces all four sites to be handled, and an unhandled one is a compile error, which is the real guard here. `node scripts/check-renderer-style.cjs` with views/HeadlessRuns.tsx still at 0 inline style objects. Manually: launch against an empty runs table and confi
  - migration: none.
- **Delete the Goal autopilot slot row until a launcher exists** `small` · _honesty_
  - files: `src/renderer/src/views/Settings.tsx`
  - goal: Settings › Dispatcher stops shipping a concurrency limit for a lane nothing can start. Verified: `control.setAutopilot` is registered in main (index.ts:2000-2001), bound in the preload (416-417) and called by no renderer — the only non-smoke callers are control.ts's own dispatcher — so the 'node' queue kind can never acquire a row and its meter can only ever report "none of 2 running". Deleting th
  - approach: 1. Remove the `{ id: 'node', label: 'Goal autopilot', … }` entry from `KIND_COPY` (Settings.tsx:2656-2659), leaving the four reachable lanes. Put a comment in its place: ```ts // No 'node' row. Goal autopilot's dispatcher exists in main (control.ts:836) // but nothing in the renderer calls control.setAutopilot, so the lane can // never hold a queue row and a slot control for it is a control for a feature // the operator cannot reach. The stored limit is preserved either way; put the // row back in the same change that ships the launcher. ``` 2. Drop `node: 0` from the `running` accumulator's i
  - verify: `npm run typecheck` and `node scripts/check-renderer-style.cjs` with views/Settings.tsx ≤269. Manually: open Settings › Dispatcher, confirm four lanes and no "none of 2 running" row, change and save a limit, reload, and confirm the saved values still round-trip. The equivalence assertion lands in th
  - migration: none, and deliberately no schema or settings write: the `slots` setting keeps its `node` key, so re-adding the row later restores the operator's existing value rather than a default.
- **Make the Usage window and the Fleet tile say what they count** `small` · _honesty_
  - files: `src/renderer/src/views/Usage.tsx`, `src/renderer/src/views/Fleet.tsx`
  - goal: Two surfaces stop stating something the code does not do. Usage opens on 14 days while its picker offers only 7/30/90, so the select renders "Last 7 days" as its selection while the heading below reads "last 14 days". And Fleet's "Needs you" tile counts only `attention.kind === 'permission'` while the sidebar's "n need you" counts permission, error and finished (App.tsx:100-101 `NEEDS_YOU`), so th
  - approach: Usage (src/renderer/src/views/Usage.tsx:317) — change the option list to `{[7, 14, 30, 90].map((value) => <option key={value} value={value}>Last {value} days</option>)}`. Keep `useState(14)` at 240: 14 is main's own DEFAULT_DAYS (usage.ts:18) and changing the data window is not what this finding is about; making the control able to name the state it starts in is. Verified `load` depends on `days` and passes it to `usage.snapshot({ days, force })` (245-249), so a 14 option genuinely re-reads at 14. The heading at 376 (`{snap?.days ?? days}`) and the reading line at 384 then agree with the picke
  - verify: `npm run typecheck` and `node scripts/check-renderer-style.cjs` with both baselines unchanged. Manually: open Usage and confirm the picker reads "Last 14 days" on first paint and the heading agrees, then switch to 7 and confirm both move together; open Fleet with one blocked agent and confirm the ti
  - migration: none.
- **Copy the goal id, and promise no link Wanigan cannot open** `small` · _honesty_
  - files: `src/renderer/src/views/Control.tsx`
  - goal: "Copy goal link" stops putting `file:///…/index.html#goal=<id>` on the clipboard under a notice promising "Opening it in Wanigan returns to this exact durable goal". Nothing in the app registers a protocol handler or opens a URL, so that link opens nowhere. Split from the label fixes because this changes what actually lands on the clipboard, not only what a label says.
  - approach: src/renderer/src/views/Control.tsx — **replace** `copyGoalLink` (132-135), do not add a second function beside it: ```ts const copyGoalId = (id: string) => act(`link-${id}`, async () => {   await copyText(id); }, 'Goal id copied. Paste it where the id is useful — Wanigan has no external link that opens a goal; the Goal link beside this button returns here inside the app.'); ``` Rename the button at 254 to `Copy goal id` and point it at `copyGoalId`. Update `copyText`'s failure message (17) from 'did not accept the goal link.' to 'did not accept the goal id.'.  Leave the in-app `<a href={goalHa
  - verify: `npm run typecheck` and `node scripts/check-renderer-style.cjs` with views/Control.tsx still at 0 inline style objects. Manually: press Copy goal id and confirm the clipboard holds the bare id with no scheme or path, and that the notice makes no claim about opening it; then press Goal link and confi
  - migration: none.
- **Resolve the follow-account label without the explicit choice** `small` · _honesty_
  - files: `src/renderer/src/components/NewSessionDialog.tsx`
  - goal: The new-session account dropdown's `value=""` option describes the fallback rather than the operator's current pick. Verified: NewSessionDialog.tsx:549-554 renders `Follow {source === 'project' ? 'this project' : 'the default'} — {accountRes.account.label}` from a resolution computed WITH the explicitly chosen accountId (162), and accounts.resolve returns `source: 'explicit'` for any non-null expl
  - approach: Ask main both questions instead of reusing one answer for two purposes. Main stays the authority on account resolution — index.ts:1965-1969 is explicit that a renderer answering it would be guessing on the wrong side of the trust boundary.  1. Add state beside `accountRes` (107): `const [followRes, setFollowRes] = useState<AccountResolution | null>(null);` with the comment `// What "follow" would resolve to with no explicit choice. Resolved separately because the option describes the fallback, not the current pick: resolving it with accountId made "Follow the default" name the account the oper
  - verify: `npm run typecheck` and the style gate. Manually: with two accounts configured, open the dialog, choose the non-default account explicitly, reopen the dropdown, and confirm the `value=""` option still names the project or default account rather than the one just picked, while the sentence beneath st
  - migration: none.

### Wave 2 — 7 phases

- **Pin the ps locale, and keep a row ps listed but could not date** `small` · _dead-subsystems_
  - files: `src/main/observed.ts`
  - goal: The observed reader survives an operator whose `ps -o lstart=` is not English, and "ps did not list this pid" stops being the same code path as "its start time did not parse". This lands before any surface renders the lane, so the first UI is not shipped on top of a reader that silently drops rows.
  - approach: In `src/main/observed.ts`:  (1) Pin the locale on the probe: `exec('ps', ['-o','pid=,lstart=','-p', pids.join(',')], { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } })`. This is the load-bearing half, and for a reason the finding understates. I measured V8's parser: a French line (`dim. 07 sept. 2026 01:14:20`) parses *correctly*, a Japanese line (`2026年 9月 7日 …`) returns NaN, and a numeric day-first locale (`07/09/2026 01:14:20`) parses to **Thu Jul 09** — sixty days off, which fails the `START_SLACK_MS` comparison and drops the row as a *recycled pid*, the one branch that is supposed t
  - verify: `ps` cannot be made to emit a foreign-locale line on demand, so assert over the new pure export. In the `── phase 27 · observed sessions` block (smoke3 ~1718, which runs before the `missingSources.length === 0` check at 2504, so `sourceOf` is safe here): `check(parsePsStart('54186 Sun Sep  6 01:14:2
- **Record why autopilot halted, and let an existing goal be given a budget** `small` · _dead-subsystems_
  - files: `src/main/control.ts`, `src/shared/types.ts`, `src/main/index.ts`, `src/preload/index.ts`
  - goal: The two facts an autopilot surface needs and cannot get today become available: why the last automatic halt happened, as a typed field rather than a summary string the renderer has to parse; and a way to give an existing goal the budget `setAutopilot` requires, without which a goal created without one can never arm autopilot at all.
  - approach: `src/main/control.ts`: - `export const AUTOPILOT_HALT_PREFIX = 'Autopilot stopped: ';` and change `haltAutopilot` (control.ts:821) to write `` `${AUTOPILOT_HALT_PREFIX}${reason}` `` so the prefix has one writer. The literal string it produces is unchanged, which matters — smoke3:2337 asserts `proof.summary.startsWith('Autopilot stopped:')`. - `function autopilotHalt(docketId: string): Pick<DocketAutopilot,'haltedReason'|'haltedAt'>` running `SELECT summary, created_at FROM work_proofs WHERE docket_id=? AND kind='decision' AND summary LIKE ? ORDER BY created_at DESC LIMIT 1` with `` `${AUTOPILO
  - verify: In the `── P31 · autopilot dispatch` block, immediately after the existing halt-evidence assertion at smoke3:2337 (and after it, so no new sweep perturbs the `swept === 2` and `sweepAutopilot() === 0` counts above it): `const halted = control.docket(capped.id).autopilot; check(halted.haltedReason !=
  - migration: none — `work_dockets.budget_usd` and the three `autopilot*` columns already exist, and the halt reason is read back from the `work_proofs` rows `haltAutopilot` has always written. No new column, no backfill, and a database that has never armed autopi
- **Say what each task waits on, so “blocked” stops meaning two things** `small` · _dead-subsystems_
  - files: `src/renderer/src/views/Control.tsx`, `src/renderer/src/styles/control.css`
  - goal: Every task card names its prerequisites and their statuses, so `blocked` can be read. `mapNodes` (control.ts:122-128) returns `blocked` both for "a prerequisite failed" and for "a prerequisite has not finished yet", and today nothing on screen distinguishes them — on any graph wider than a chain the operator cannot tell whether to wait or to reopen something.
  - approach: Split out of the plan-editor phase because it is independently shippable, closes the ambiguity on the *existing* four-phase chain as well as on any future graph, and de-risks the large phase by landing the NodeCard signature change on its own.  `src/renderer/src/views/Control.tsx`: - `NodeCard` gains a `prereqs: { title: string; status: DocketNodeStatus }[]` prop, computed at the call site (Control.tsx:236) as `node.dependsOn.map((id) => detail.nodes.find((n) => n.id === id)).filter((n): n is DocketNode => !!n).map((n) => ({ title: n.title, status: n.status }))`. Add `DocketNodeStatus` to the 
  - verify: In the wiring block: `check(controlViewSrc.includes('Waits on') && controlViewSrc.includes('prereqs') && !/Start <em>Plan<\/em> first/.test(controlViewSrc), 'a task card names its prerequisites and their statuses, and the guide no longer describes a fixed four-step chain as the only shape')`. Behavi
- **Strip the ambient Anthropic credential on the headless path too** `small` · _trust-boundary_
  - files: `src/main/sessions.ts`, `src/main/headless.ts`
  - goal: The strip finding [8] is about exists on only one of the two launch paths. `agentEnv` (sessions.ts:228-262) drops an inherited `ANTHROPIC_API_KEY`/`ANTHROPIC_ADMIN_KEY` — by name, and then by value — whenever the resolved provider environment redirects the Anthropic API. `headlessEnv` (headless.ts:178-200) copies `process.env` wholesale, applies `providerEnv` then `accountEnv`, and has no strip of
  - approach: In `src/main/sessions.ts`, extract the block at :228-262 into `export function stripAmbientAnthropicCredentials(out: Record<string, string | undefined>, providerEnv: Record<string, string>): void`, moving its three existing comments with it verbatim (the "consent dialog can be padded off-screen" paragraph, the "the name test above is not enough" paragraph, and the "so the value decides, not the name" paragraph) and adding one sentence: "Both launch paths call this. The attended path has stripped the ambient key since the redirect guard was written; a headless run inherits the same shell and re
  - verify: In `src/main/smoke4.ts`, beside the existing `headlessEnv` assertions (~1280-1288). First a direct unit test of the extracted function, imported from `./sessions`: build `const out: Record<string, string | undefined> = { KEEP: 'plain', COPY: 'sk-ant-smoke-ambient-value', ANTHROPIC_API_KEY: 'sk-ant-s
- **Confine every path code.ts hands outward, not just the Finder exit** `small` · _trust-boundary_
  - files: `src/main/code.ts`
  - goal: `openInEditor` confines its target once, above the branch that chooses between LaunchServices and an editor CLI, so neither exit can be reached with a path outside every managed root. Today only the `editorPath === null` exit calls `assertOpenablePath` (code.ts:101); the editor exit goes straight from `approvedEditorPath` to `exec(editor, [target])` (code.ts:107-109), and `normalizeEditorTarget` i
  - approach: In `src/main/code.ts`, inside `openInEditor` (lines 94-111): after `const safeLine = normalizeEditorLine(line);` and BEFORE `if (editorPath === null) {`, insert a bare `assertOpenablePath(safeTarget);`, and delete the existing call from inside the null branch. Discard the return value deliberately — `assertOpenablePath` returns the canonical path, and both exits must keep passing the un-canonicalised `safeTarget` to `shell.openPath` and to `exec`, for the reason `listDir` already records at code.ts:305-310 (a project under `/tmp` canonicalises to `/private/tmp`, and returning the canonical for
  - verify: Two additions to `src/main/smoke3.ts`. (1) In the `── external editor launcher boundary` block (421-450), after the `detectedEditor` fixture, add a behavioural pair that proves both exits refuse and neither spawns, because the hoisted assertion throws before `detectEditors()` is reached: `const outs
- **Tint every provider row from one table, with a fallback** `small` · _sessions-and-launch_
  - files: `src/shared/provider-status.ts`, `src/renderer/src/views/Sessions.tsx`, `src/renderer/src/views/Fleet.tsx`, `src/renderer/src/components/NewSessionDialog.tsx`
  - goal: A DeepSeek session's rail dot is DeepSeek-coloured instead of transparent, any pack profile draws in the neutral accent instead of nothing, and the provider tint table is declared once instead of in three files that already disagree. The sessions/launch smoke module exists for every later phase in this lane to append to.
  - approach: Add to src/shared/provider-status.ts, beside `runsClaudeHarness` and documented the way it is: `const PROVIDER_TINT: Record<string, string> = { claude: 'var(--claude)', codex: 'var(--codex)', glm: 'var(--glm)', deepseek: 'var(--series-4)' };` and `export function providerTint(providerId: string): string { return PROVIDER_TINT[providerId] ?? 'var(--accent)'; }`. The doc comment states the rule the three copies broke: these are token names from index.css (:137-139, :144 light / :201-203, :208 dark), never literal colours, and a profile id this build has no colour for is drawn in the neutral acce
  - verify: In smoke11, a `say('── provider tint · one table, and a fallback for a profile this build has no colour for')` group. Behavioural: `providerTint('deepseek') === 'var(--series-4)'` and `providerTint('claude') === 'var(--claude)'` — "the shipped DeepSeek profile has a tint, which Sessions.tsx never ga
- **Announce the composer's skill menu to assistive technology** `small` · _sessions-and-launch_
  - files: `src/renderer/src/components/Composer.tsx`, `src/renderer/src/styles/composer.css`
  - goal: Typing `$` in the composer announces that a menu opened, how many skills it holds, which one the arrow keys are on, and therefore that Enter has changed meaning — using the pattern already proven in Skills.tsx rather than one that would put an invalid role on a textarea and leave `aria-controls` pointing at nothing.
  - approach: Follow Skills.tsx:501-558, which is the same widget correctly wired, and do not follow the shape the original finding proposed: `role="combobox"` is not permitted on a `<textarea>` (implicit role textbox, and HTML-ARIA permits no role change), `aria-expanded` is not supported on textbox, and the cited precedent puts combobox on an `<input type="text">`. On the textarea (Composer.tsx:350-363) add only the two attributes a textbox does support — `aria-controls="composer-skill-menu"` and `aria-activedescendant={menu && menuOptions.length ? `composer-skill-${menu.index}` : undefined}`. Render the 
  - verify: The smoke process has no renderer and cannot import a .tsx, so this is asserted as source strings the way smoke3 asserts every other renderer fact. In smoke12, a `say('── composer skills menu · the textarea says what opened')` group over `sourceOf('src/renderer/src/components/Composer.tsx')`: contai

### Wave 3 — 7 phases

- **Move the default docket plan and node kinds into shared/types** `small` · _dead-subsystems_
  - files: `src/shared/types.ts`, `src/main/control.ts`
  - goal: The four default phases, the node-kind list and the two plan limits are declared once, in the module both processes read, so a renderer plan editor can seed from exactly what main would have written instead of a second copy that drifts.
  - approach: `src/shared/types.ts`, beside `DocketPlanNode` (types.ts:919-927) and following the file's established precedent for runtime exports (`DEFAULT_SLOTS` at 1300, `TRUST_COPY` at 1444, `INJECTABLE_KINDS` at 1703 — and `src/main/learning/briefing.ts:3` and `src/main/attention.ts:2` already import runtime values from it, so the main bundle handles this fine): `export const DOCKET_NODE_KINDS: readonly DocketNodeKind[] = ['plan', 'implement', 'verify', 'review'];` `export const MAX_DOCKET_PLAN_NODES = 40;` `export const MAX_DOCKET_NODE_DEPENDENCIES = 16;` `export const DEFAULT_DOCKET_PLAN: readonly Do
  - verify: In the `── phase 30 · durable work control` block: `check(DEFAULT_DOCKET_PLAN.length === 4 && DEFAULT_DOCKET_PLAN[3].kind === 'review' && DOCKET_NODE_KINDS.length === 4, 'the default plan and the kind list are shared values, not two copies')`. In the wiring block: `check(controlSrc.includes('DEFAULT
- **Make viewMemory safe to consume: honest scroll, honest store writes** `medium` · _state-and-errors_
  - files: `src/renderer/src/components/viewMemory.ts`
  - goal: The mechanism can be adopted without losing what it claims to keep: a restore works for a scroller that mounts after first paint, a StrictMode remount can no longer overwrite a saved offset with 0, a store write survives a setter call made in the same tick as an unmount, and a view that crashed really does get a cleared scope on Reload.
  - approach: Four changes to src/renderer/src/components/viewMemory.ts. (1) DELETE the cleanup's `store.set(full, el.scrollTop);` at line 140 (keep `ro.disconnect()`, `removeEventListener` and `want = null`). React.StrictMode is on (src/renderer/src/main.tsx wraps App in <React.StrictMode>), so every mount runs effect → simulated cleanup → effect. On the first pass the restore has usually not settled (`settled` is false, the ResizeObserver is still waiting for rows to arrive), so the cleanup writes the element's current scrollTop — 0 — over the saved offset, and the second pass then restores 0. The author'
  - verify: Typecheck only in this phase (no consumer yet). The trailing pin phase asserts `viewMemorySrc.includes('export function useRememberedScrollRef')`, `viewMemorySrc.split('store.set(full, el.scrollTop)').length === 2` — one write site, in onScroll, and never in the cleanup — `viewMemorySrc.includes('la
- **Reconcile Git's diff pane with the status it just read** `medium` · _state-and-errors_
  - files: `src/renderer/src/views/Git.tsx`
  - goal: After staging, unstaging, discarding or committing, the detail pane shows the patch for the state the repository is actually in — or nothing at all when the file is gone — and a commit message drafted for one project no longer follows you into another.
  - approach: In src/renderer/src/views/Git.tsx. (1) Name the selection at module level: `type Sel = { kind: 'commit'; hash: string } | { kind: 'file'; path: string; staged: boolean } | null;` and use it for the useState at line 126. (2) Make the reload readable by its caller: change `load` (line 148) to `useCallback(async (): Promise<Status | null> => …, [root, showAll])`, returning `null` when `!root` and in the catch, `s` at the non-repo early return and `s` at the end. `useEffect(() => { void load(); const t = setInterval(load, 8000); … }, [load])` at line 168 and every other `void load()` caller need n
  - verify: The trailing pin phase asserts `gitViewSrc.includes('await syncSelection(await load())')`, `gitViewSrc.includes('function findFile(status: Status, path: string)')` and that the project select's onChange contains `setMsg('')`. Manually, in both themes: select an unstaged file's diff and press + — the
- **Bound composer drafts to one pruned localStorage key** `medium` · _state-and-errors_
  - files: `src/shared/composer-drafts.ts`, `src/renderer/src/components/Composer.tsx`
  - goal: Unsent composer text stops accumulating one permanent localStorage key per session ever launched: it lives in a single key, bounded by both a count and a character budget, with the keys the old scheme left behind folded in once and removed — and the bound is a rule the code enforces rather than a quota error it swallows.
  - approach: New file src/shared/composer-drafts.ts, pure and importable by both the renderer and the main-process smoke suite — the pattern src/shared/palette.ts already sets (smoke10.ts:1 imports it). Exports: `COMPOSER_DRAFTS_KEY = 'wanigan.composerDrafts'`; `COMPOSER_DRAFT_PREFIX = 'wanigan.composerDraft.'` (the legacy per-session prefix, kept only so the fold can find them — it is the exact string at Composer.tsx:28); `COMPOSER_DRAFT_MAX = 25`; `COMPOSER_DRAFT_TOTAL_CHARS = 200_000`; `type ComposerDraftMap = Record<string, { text: string; at: number }>`; `parseDraftMap(raw: string | null): ComposerDra
  - verify: Behavioural assertions in the trailing pin phase, importing from '../shared/composer-drafts' the way smoke10.ts imports '../shared/palette': putDraft with '' and with '   ' both remove the entry; pruneDrafts over 30 small entries returns exactly COMPOSER_DRAFT_MAX and keeps the newest `at` values; p
  - migration: none — localStorage only. Legacy `wanigan.composerDraft.*` keys are folded then deleted, so no unsent text is dropped on upgrade unless a browser profile holds more than 25 drafts or more than 200_000 characters of them, in which case the oldest go. 
- **Name the Usage daily chart and give it a day-by-day table** `medium` · _visual-and-copy_
  - files: `src/renderer/src/views/Usage.tsx`, `src/renderer/src/styles/usage.css`
  - goal: The stacked daily chart stops being unreadable without colour and unreachable without sight: it gains an accessible name, its series come from the four themed slot tokens instead of --accent, --codex and four unthemed hex literals, and the day dimension — which reaches the screen nowhere else — becomes a real table under the chart.
  - approach: Create src/renderer/src/styles/usage.css and add `import '../styles/usage.css';` to Usage.tsx (the pattern Settings.tsx:15 already uses). Move the eleven static inline style objects out of DailyChart (Usage.tsx:143-196) into it — `.u-chart` (grid, gap var(--s-2)), `.u-bars` (flex, align-items flex-end, gap var(--s-1), height 116px, overflow-x auto), `.u-col` (flex 1 0 14px, min-width 14px, column, justify-content flex-end, height 100%), `.u-axis` (flex, space-between) with `.u-axis span { font-size: var(--t-micro) }`, `.u-empty` (font-size var(--t-small), margin 0), `.viz-table th.u-th-r { tex
  - verify: Assertion lands in the pin phase. In this phase: `npm run typecheck`, `node scripts/check-renderer-style.cjs` (confirm with --print-baseline that `usage.css` reports 0 px font sizes and `styles/usage.css` does not appear in DURATION at all), `npm run smoke`, and before/after screenshots in both them
- **Remember Control's goal status filter** `small` · _state-and-errors_
  - files: `src/renderer/src/views/Control.tsx`
  - goal: A goal list narrowed to one status stays narrowed when you come back from a terminal, instead of silently widening to All.
  - approach: In src/renderer/src/views/Control.tsx add `import { useViewMemory } from '../components/viewMemory';` and replace line 32 `const [statusFilter, setStatusFilter] = useState<string>('all')` with `useViewMemory<string>('statusFilter', 'all')`. Every writer is unchanged: the All chip at 228 and the per-status chips at 233-234, both of which already toggle back to 'all'. The existing line 249 — "No goal has that status right now. Press All to see every goal." — is the correct exit for a remembered filter whose status has since emptied, so no new empty state is needed. This is carved out as its own 
  - verify: The trailing pin phase asserts `controlViewSrc.includes("useViewMemory<string>('statusFilter', 'all')")`. Manually: filter goals to one status, leave Control, return — the chip is still pressed and the list still narrowed.
- **Pin the four loading and failure states already in the tree** `small` · _state-and-errors_
  - files: 
  - goal: Control's loading state, Usage's rejected snapshot, Plugins' unreachable error and Schedules' one-click delete stop being uncommitted work with nothing holding it there: each becomes a named assertion in the offline suite that fails if it is reverted.
  - approach: All four are already implemented in the uncommitted working tree; I read each one and quote the exact strings below, so this phase is assertion-only and can land first. Add `const pluginsSrc = sourceOf('src/renderer/src/views/Plugins.tsx');` to the existing declaration block at smoke3.ts:2470-2496 (controlViewSrc:2477, schedulesSrc:2478, settingsSrc:2480, usageViewSrc:2482 are already there) so the `missingSources.length === 0` check at 2504 covers it and a moved file cannot retire these assertions by reading nothing. Then add a `say('── loading and failure states')` block after that check wit
  - verify: `npm run smoke` — the new block passes now (all four behaviours are present) and fails if any is reverted. `MIN_ASSERTIONS` at smoke.ts:229 is 660 and only moves upward as these land; recalibrating it belongs to finding [64], not here.

### Wave 4 — 7 phases

- **Give Git a page head and let its workbench run full-bleed** `medium` · _visual-and-copy_
  - files: `src/renderer/src/views/Git.tsx`, `src/renderer/src/styles/git.css`
  - goal: Git is the only .pane document view whose page never names itself and has no h1 for the route. After this all three of its states open with the shared PageHead, and the toolbar rule, the column divider and the diff pane run to the window edge instead of stopping at the 1120px prose measure.
  - approach: git.css — add below the header comment: `.pane.gt-view { padding: 0; }`, `.pane.gt-view > * { max-width: none; }`, `.viz`-free and colour-free, plus `.pane.gt-view > .pane-head:first-child { padding: var(--s-3); }`, with a comment saying Git is a workbench, not a document, so it opts out of the measure index.css:658 holds every document view to, and its head is the compact variant sized for a dense working surface. `max-width: none` rather than `className="pane wide"`: `.pane.wide > *` only raises the cap to --page-wide (1500px, never lifted at any breakpoint), so the same truncation returns a
  - verify: Assertion lands in the pin phase. In this phase: `npm run typecheck`, `node scripts/check-renderer-style.cjs`, `npm run smoke`, and before/after screenshots in both themes of all three states at >1350px — no project, a non-repository project, and a repository with a diff open — plus one at ≤980px co
- **Remember the Usage window across a tab switch** `small` · _state-and-errors_
  - files: `src/renderer/src/views/Usage.tsx`
  - goal: The consumption window chosen on Usage survives leaving the view, so returning does not silently re-read and re-draw a different window than the one the operator selected.
  - approach: In src/renderer/src/views/Usage.tsx add `import { useViewMemory } from '../components/viewMemory';` and replace line 240 `const [days, setDays] = useState(14)` with `const [days, setDays] = useViewMemory('days', <the current literal>)`. Read the current literal out of the file rather than assuming 14: finding [55] ("Usage opens on 14 days while the picker displays Last 7 days" — the options are `[7, 30, 90]` at line 317, so 14 matches none of them) owns that number and belongs to another cluster; if [55] lands first the literal will already be 7 or 30, and hard-coding 14 here would re-land a f
  - verify: The trailing pin phase asserts `usageViewSrc.includes("useViewMemory('days',")` — the trailing comma stops the pin from encoding a number another cluster owns. Manually: choose Last 90 days, leave the view, return — the picker still reads 90 and the section heading agrees.
- **Delete Control's private centred 1500px pane cap** `small` · _visual-and-copy_
  - files: `src/renderer/src/styles/control.css`
  - goal: Control is the only view whose scroll container floats in the middle of a wide window. After this it is held flush left at --page-wide by the same index.css rule that already holds Settings, its content gains the 48px the container cap was eating, and the two dead private rules that source order had already overridden are gone.
  - approach: Verified: control.css:5 is `.control-view { max-width: 1500px; margin: 0 auto; display: grid; gap: 18px; }`, index.css:660 is `.pane.control-view > *, .pane.set > *, .pane.wide > * { max-width: var(--page-wide); }`, and --page-wide is 1500px (index.css:114). Delete the whole declaration at control.css:5. Nothing replaces it: index.css:660 already caps Control's children, and `className="pane control-view"` on Control.tsx:186 stays exactly as it is so that selector keeps matching. The `display: grid; gap: 18px` half is dead already and goes in the same edit — control.css is @imported at index.c
  - verify: Assertion lands in the 'Pin the chrome-and-copy sweep' phase. In this phase: `node scripts/check-renderer-style.cjs` still passes, `npm run smoke` still green, and before/after screenshots of Control in both themes at a >1708px window, which is the only width where the fix is visible.
- **Put Settings on the shared PageHead and delete the dead hero rules** `small` · _visual-and-copy_
  - files: `src/renderer/src/views/Settings.tsx`, `src/renderer/src/styles/settings.css`
  - goal: Settings stops being the only view with an accent-coloured page eyebrow and a privately downsized h1, and stops reserving 40% of its header band for an aside that was removed. Its head becomes the same PageHead every other view is supposed to use, at the sanctioned compact size, and the removed aside's own rules go with it.
  - approach: Settings.tsx — add `PageHead` to the bits import at line 12 (`import { ConfirmNote, Explainer, Note, PageHead, Section, Stat, ago, num } from '../components/bits';`) and replace the `<header className="set-hero">` block at lines 652-658 with `<PageHead compact title="Settings" lead="Grouped by the job you are doing. Switches save at once; a Save button applies the fields beside it." />`. Pass no eyebrow: bits.tsx:241-244 says the eyebrow is the view's section noun or nothing and never an app-name slogan, which is exactly what 'Wanigan control center' is; and 'Settings' over 'Settings' is an ec
  - verify: Assertion lands in the pin phase. In this phase: `npm run typecheck`, the style gate, `npm run smoke` (the four pins above are in the same suite), and before/after screenshots in both themes at a wide window and at ≤1024px where the deleted media rules used to fire.
- **Name the decision and the missing base commit in Control** `small` · _visual-and-copy_
  - files: `src/renderer/src/views/Control.tsx`
  - goal: Two sentences in Control stop misstating what the main process did: a review decision is announced in words that match control.ts's actual writes rather than an enum id run through `replace('_', ' ')`, and a goal with no base commit says so instead of rendering the fragment 'base not a git repo'.
  - approach: (a) Base commit, Control.tsx:254. The current expression is `<span className="mono">base {detail.baseCommit?.slice(0, 10) ?? 'not a git repo'}</span>`; move the whole phrase into the fallback: `<span className="mono">{detail.baseCommit ? `base ${detail.baseCommit.slice(0, 10)}` : 'no base commit recorded'}</span>`. Do not diagnose the cause: null has several causes and the renderer has no repoState API to tell them apart, so 'this project is not a git repository' would be a guess presented as fact. (b) Decision notice, Control.tsx:164, currently `}, decision === 'approve' ? 'Task decision reco
  - verify: Assertion lands in the pin phase. In this phase: `npm run typecheck`, the style gate, `npm run smoke` (2908-2910 must still pass), and a manual pass on a goal with a review node — press Approve, Request changes and Reject on three goals and confirm each notice matches the status the goal list then s
- **Call the record a goal in the palette and every main-process sentence** `small` · _visual-and-copy_
  - files: `src/shared/routes.ts`, `src/main/control.ts`, `src/main/index.ts`
  - goal: ⌘K stops introducing 'dockets' as a second kind of record and stops sending a worktree search to a view that has no worktree UI. The word a person reads is 'goal' in the palette and in every main-process sentence Control surfaces; 'docket' survives only as a schema and type identifier and in the one agent-facing launch prompt that moves with sessions.ts.
  - approach: routes.ts:17 — `hint: 'Goals — a contract, a task graph, evidence and your decision'`; leave `keywords: 'goals goal dockets tasks work graph'` alone so the schema word still finds the view. routes.ts:23 — `hint: 'History, working tree, branches, stashes and the review gate for one repository'` (the same sentence GitHead gets, so change both or neither) and `keywords: 'commits diff branches stash staged pull request pr review gate'`. Both halves are required: palette.ts:35 matches `${item.title} ${item.hint} ${item.haystack}`, so dropping 'worktrees' from keywords alone leaves the false hit tha
  - verify: Assertions land in the pin phase. In this phase: `npm run typecheck`, `npm run smoke`, and a manual ⌘K for 'worktree' confirming Settings › Worktrees now outranks Git, plus a ⌘K for 'docket' confirming Control is still found by the schema word.
  - migration: none — but note the one data consequence: control.ts:224 is DEFAULT_PLAN's stored `instructions` text, copied into work_nodes at creation. Goals already in the database keep the old sentence and are rendered as-is by Control.tsx's NodeCard; only goal
- **Stop announcing Scout's whole proposal queue on every change** `small` · _visual-and-copy_
  - files: `src/renderer/src/views/ImprovementScout.tsx`, `src/renderer/src/styles/improvement-scout.css`
  - goal: Improvement Scout stops speaking up to 150 proposal articles — titles, summaries, reason codes and button labels — into a polite live region on first load, on a broadened filter, on a reorder and after every status change. One short sentence in the filter bar carries the loading, filtered-count and no-match states instead.
  - approach: Delete `aria-live="polite"` from `<section className="scout-results">` at ImprovementScout.tsx:649. (There is no comment justifying that attribute anywhere in the file — the original design cited lines 319-323, which are the EFFORT_RANK doc comment and unrelated; nothing has to be rewritten, but do add a one-line comment on the section saying the queue is a list, not an announcement, and that the count sentence in the filter bar is the announced channel.) Removing it alone would drop the loading and empty-state announcements, so replace them in the filter bar (`.scout-filter-copy`, line 641), 
  - verify: Assertion lands in the pin phase. In this phase: `npm run typecheck`, the style gate, `npm run smoke`, and a VoiceOver pass — load the view, type in Find, clear it, and change Order, confirming one short utterance each time and no article text. Do not expect an utterance from Mark reviewed with no s

### Wave 5 — 7 phases

- **Make the Plugins file reader a real dialog** `small` · _visual-and-copy_
  - files: `src/renderer/src/views/Plugins.tsx`
  - goal: Opening a plugin's SKILL.md or README stops disabling the whole shell keyboard while answering no key itself. The reader gets Escape, a working focus trap that includes the scrollable body, initial focus, focus restore and a portal out of the .body stacking context — the contract its aria-modal attribute has been claiming.
  - approach: The hook cannot be called from Plugins() itself — useDialog sets `document.documentElement.dataset.modalOpen` on mount (useDialog.tsx:92), so an unconditional call would kill ⌘1-9, ⌘K and `?` for as long as the Plugins view is open. Extract the overlay into its own component at the bottom of the file and mount it only when there is something to read. Add `import { useDialog } from '../components/useDialog';`. Replace the block at Plugins.tsx:542-553 with `{reading && <ReaderDialog title={reading.title} text={reading.text} truncated={reading.truncated} onClose={() => setReading(null)} />}`. The
  - verify: Assertion lands in the pin phase. In this phase: `npm run typecheck`, the style gate, and a keyboard pass — open a README, press Escape (closes), Tab (moves Close → body → Close and never leaves), arrow keys with the body focused (it scrolls), and after closing confirm focus is back on the button th
- **Give backup and restore its first behavioural coverage** `large` · _tests-and-parsers_
  - files: 
  - goal: The only code path that replaces the SQLite file CLAUDE.md calls the source of truth is verified by running it: the copy is proved consistent, every manifest and digest refusal is proved to fire, all three restore refusals are proved to happen before anything moves, and one successful restore is proved to have actually swapped the file — instead of being verified by the presence of 'Backup & resto
  - approach: WHY THIS IS SAFE TO RUN AT ALL — verify this first, before writing a line. `scripts/smoke.sh` sets `UDD="$(mktemp -d)"`, launches `./node_modules/.bin/electron . --user-data-dir="$UDD"`, and `rm -rf "$UDD"` afterwards. `dataDir()` is `app.getPath('userData')`, so every file this phase moves lives in that throwaway directory. If that ever stops being true this phase must not run.  WHY IT MUST BE LAST. `restoreBackup` closes the process's connection on purpose (backup.ts, `relaunchRequired: true`) and `db()` is `if (_db) return _db;` (db.ts:41-42) with no `.open` check and no reset anywhere, so 
  - verify: `npm run smoke` prints the new `── backup and restore · the source of truth` group with all assertions green and the suite still exits 0. Then prove the phase can fail, reverting each: (a) invert `wouldDiscardNewer` in backup.ts (`currentEvidenceAt < backupEvidenceAt`) and confirm assertions 20/21 f
  - migration: none — the phase writes one `settings` row and one `policy_ledger` row into the throwaway smoke profile and deletes the ledger row explicitly before the restore; no schema change, and backup.ts itself is not modified.
- **Give transcript turns a real table so session_id is indexed** `large` · _perf-and-style_
  - files: `src/main/db.ts`, `src/main/transcripts.ts`, `src/main/learning/ledger.ts`
  - goal: The three queries that filter transcript rows by `session_id` stop scanning the whole full-text index. Archiving a session, forgetting one, and scanning a session's turns for knowledge citations all become index seeks, and `transcript_turns` becomes one source of truth instead of an index that also has to answer non-text questions.
  - approach: db.ts, in the additive-migration section beside the other `CREATE TABLE IF NOT EXISTS` statements: add `transcript_turns (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, at INTEGER, text TEXT NOT NULL)` with `CREATE INDEX IF NOT EXISTS idx_transcript_turns_session ON transcript_turns(session_id)`, then an external-content index `CREATE VIRTUAL TABLE IF NOT EXISTS transcript_turns_fts USING fts5(text, content='transcript_turns', content_rowid='id')` plus the three standard `_ai`/`_ad`/`_au` triggers. Triggers rather than explicit index writes, so a direct insert into `tran
  - verify: Existing behavioural coverage is the safety net and must stay green unchanged: smoke3.ts:2421-2432 (recall scoped to project, frozen backend and frozen account; credential redaction in snippets) and smoke4.ts:1001-1010 (`recordTranscriptCitations` counts and unknown-id handling). Add four checks in 
  - migration: Additive plus one deliberate content move. New table, new index, new virtual table, three triggers, one marker table, one guarded backfill. No existing table is altered or dropped and no column is removed; `transcript_fts` survives as an empty table 
- **Stop the shell's polls while the window is hidden** `medium` · _perf-and-style_
  - files: `src/renderer/src/App.tsx`, `src/main/index.ts`
  - goal: The two `setInterval`s in the always-mounted shell stop doing work nobody is reading, the project list stops installing a new array identity every 30 seconds, and the phone's branch label stops depending on a visible desktop window.
  - approach: App.tsx: (1) add `const projectShape = (l: Project[]) => l.map((p) => `${p.id}:${p.name}:${p.branch ?? ''}`).join('|');` beside `shape` (line 123) and `attentionShape` (line 125), with the same one-line comment they carry. (2) Replace the branch interval at App.tsx:404-407 (`window.wanigan.projects.refresh().then(setProjects).catch(() => {})`) with a `refreshProjects` useCallback that compares before setting: `void window.wanigan.projects.refresh().then((next) => setProjects((prev) => (projectShape(prev) === projectShape(next) ? prev : next))).catch(() => {})`, and wrap the interval body in `i
  - verify: src/main/smoke3.ts `── wiring` block, as its own `check` rather than folded into an existing one. Do NOT use the originally proposed `(appSrc.match(/if \(document\.hidden\) return;/g) ?? []).length === 2` — a count assertion fails on the next legitimate guard added anywhere in App.tsx. Assert the tw
- **Tokenise the last nine literal transition durations** `medium` · _perf-and-style_
  - files: `src/renderer/src/styles/sessions.css`, `src/renderer/src/styles/evals.css`, `src/renderer/src/styles/settings.css`, `src/renderer/src/styles/learning.css`, `src/renderer/src/styles/timeline.css`, `scripts/check-renderer-style.cjs`
  - goal: Every remaining literal duration in the renderer goes through `--mo-state`, so Settings › Motion = off and the OS reduced-motion preference reach the last nine declarations, and `DURATION_BASELINE` in the style gate drops to empty.
  - approach: Nine declarations, each confirmed present at the exact line by re-running the gate's own DURATION regex over the tree: sessions.css:102 `transition: transform 140ms ease, visibility 0s linear 140ms;` → `transform var(--mo-state) var(--mo-ease), visibility 0s linear var(--mo-state)`; sessions.css:109 `transform 140ms ease` → `transform var(--mo-state) var(--mo-ease)`; evals.css:82 (`.skills-chip`, three `.12s`); settings.css:116 (`.set-track`), :119 (`.set-knob`), :125 (`.set-opt`); learning.css:375 (`.learning-switch`) and :380 (`.learning-switch::after`); timeline.css:87 (`.tl-chip`). Replace
  - verify: `node scripts/check-renderer-style.cjs` must print `0 literal durations outside motion.css`; with `DURATION_BASELINE = {}` the gate then allows zero anywhere, so any future literal fails. Screenshots of Sessions (compact width, rail open and closed), Settings › Appearance, Learning › Context switche
- **Make the demo-mask and palette-cap smoke assertions able to fail** `small` · _tests-and-parsers_
  - files: 
  - goal: The two assertions in the suite that pass for any implementation of the code they name are replaced by assertions that fail when that code is removed: demo mode's email and author redaction is tested against strings that are not already the mask targets, and the palette's transcript cap is tested at the two App.tsx call sites rather than against itself.
  - approach: ANCHORS (verified in the working tree, the finding's numbers were stale by ~78): the block comment `/* -- demo mode: partial masking is the failure` is smoke3.ts:2946, `say('-- demo mode')` :2947, `const user = …` :2952, `email: 'alex@example.com'` :2957, the dead assertion `check(!JSON.stringify(masked).includes('@gmail.com'), …)` :2962, `demo.setDemo(false)` :2969. Anchor on the text, not the numbers.  src/main/smoke3.ts, the `-- demo mode` block:  1. KEEP `const user` (smoke3.ts:2952) rather than deleting it, and make it load-bearing. It is dead today only because nothing uses it; the findi
  - verify: `npm run smoke`: the `-- demo mode` group prints four ticks where it printed one plus the precondition, and the `── wiring` group prints the new transcript-cap line. Then prove each new assertion can fail, reverting after each: (1) comment out `out = out.replace(EMAIL, DEMO_EMAIL);` at src/main/demo
- **Make teach() enforce the 32 KB limit it actually has** `small` · _tests-and-parsers_
  - files: `src/main/learning/signals.ts`, `src/main/learning-service.ts`
  - goal: The ceiling teach() states is the ceiling that applies. A teaching between 32 KB and 128 KiB is refused up front in the words of the box the user typed into, instead of being accepted by the documented limit and then rejected by recordSignal with an error naming "Signal detail" — an object the user has never seen — and a different number.
  - approach: src/main/learning/signals.ts:  1. Replace the inline `32 * 1024` at :44 with an exported constant and an exported measurer, so a caller that builds a detail can refuse an oversized one against the same rule instead of advertising a different one: ```ts /** What a serialised signal detail may weigh. */ export const SIGNAL_DETAIL_MAX_BYTES = 32 * 1024;  /** The size recordSignal will measure. JSON escaping expands a string after any  *  check on its raw byte length, so a caller must weigh the serialised object. */ export function signalDetailBytes(detail: unknown): number {   return Buffer.byteL
  - verify: `npm run smoke` shows four new ticks in the compound suite. Prove the guard is not merely moved: revert learning-service.ts to `Buffer.byteLength(text,'utf8') > SIGNAL_DETAIL_MAX_BYTES` and confirm the newline-heavy assertion fails with the old "Signal detail is too large" message leaking through, t

### Wave 6 — 7 phases

- **Put index.css ahead of the sheets that modify its frame** `medium` · _perf-and-style_
  - files: `src/renderer/src/main.tsx`, `src/renderer/src/styles/schedule.css`, `src/renderer/src/styles/queue.css`, `src/renderer/src/styles/settings.css`, `src/renderer/src/views/Plugins.tsx`
  - goal: A feature sheet imported from a view can modify `.pane`/`.pane-head` again, the two dead `.pane-head` modifiers are resolved (one raised, one deleted), and the private `.sr-only` copy that the swap would otherwise start shadowing is removed.
  - approach: Two mechanisms, and the finding named only one. (a) Sheets imported from a `.tsx` — exactly eight: runs.css (HeadlessRuns.tsx:6), sessions.css (Sessions.tsx:17), learning.css (Learning.tsx:23), settings.css (Settings.tsx:15), insights.css (Insights.tsx:4), batches.css (Batches.tsx:7), improvement-scout.css (ImprovementScout.tsx:4), session-learning.css (SessionLearning.tsx:11) — land before index.css because main.tsx:3 imports `./App` before main.tsx:4 imports `./index.css`. Swap those two lines (`import './index.css';` then `import App from './App';`, leaving `./styles/compact.css` last at li
  - verify: Build and check byte offsets in `out/renderer/assets/index-*.css`: `.pane {` and `.pane-head {` must now appear before `.hr-view {`, and `.sc-head` must be written as `.pane-head.sc-head`. Screenshots in both themes of Runs (section gap and the three-stat grid), Schedules (count on the h1 baseline),
- **Guard Codex's state-index read behind a root that needs it** `small` · _perf-and-style_
  - files: `src/main/codex-sessions.ts`
  - goal: `backfillCodexThreadIds()` stops opening every Codex home's `state_5.sqlite` read-only when the pass has provably nothing to match. This closes the remainder of finding 10; the two larger halves already landed in the working tree, which I re-verified (sessions.ts:1704 names the fifteen columns Recent reads, and sessions.ts:1687 is `try { if (codexIdentityRepairPending()) backfillCodexThreadIds(); 
  - approach: src/main/codex-sessions.ts:554: change `applyMatches(stateThreads() ?? []);` to `if (roots.length) applyMatches(stateThreads() ?? []);`, mirroring the guard already on the rollout path at line 555. `applyMatches` returns early on `!roots.length` (line 541), but JavaScript evaluates the argument first, so `stateThreads()` (line 277) walks `codexHomes()`, opens `state_5.sqlite` per home and runs `PRAGMA table_info(threads)` (stateThreadsIn, line 289) even when nothing is repairable. Extend the comment at 552-553 — which correctly says the read is 'cheap and current' — with one sentence recording
  - verify: Do NOT write the originally proposed `check(backfillCodexThreadIds() === 0, 'a backfill ... does not reopen Codex state')` — a return value of 0 is the UPDATE change count and cannot observe whether `stateThreads()` ran, so that message would assert something the check does not test, and the smoke3.
- **Minify the renderer bundle and keep the views eagerly imported** `small` · _perf-and-style_
  - files: `electron.vite.config.ts`
  - goal: The renderer ships minified while main and preload stay readable, and the decision not to code-split is recorded where the next audit will read it rather than re-raised.
  - approach: electron.vite.config.ts: merge into the existing `renderer` block ONLY — `esbuild: { keepNames: true },` beside `plugins` (line 26), and `minify: 'esbuild'` merged into the existing `build` key at line 27 alongside `rollupOptions.input`. Do not add `sourcemap`; leave it at the default false. Leave `main` (which carries `rollupOptions.external: ['node-pty','better-sqlite3']`) and `preload: {}` alone: `scripts/smoke.sh` runs `npm run build` before launching real Electron, and a minified main mangles the `error.stack` that `failSmokeBootstrap` prints at src/main/index.ts:111-121 — what smoke.sh's
  - verify: Run `npm run build`, record `ls -la out/renderer/assets` before and after in the commit message, and manually throw from one view in the built output to confirm the ErrorBoundary component stack still names a view rather than a mangled identifier. Then in src/main/smoke3.ts `── wiring`, add `const v
- **Delete the two dead private small-button families** `small` · _perf-and-style_
  - files: `src/renderer/src/styles/control.css`, `src/renderer/src/styles/evals.css`, `src/renderer/src/views/Control.tsx`, `src/renderer/src/views/Skills.tsx`, `scripts/check-renderer-style.cjs`
  - goal: `.btn-small` and `.skills-btn-sm` — two private class families that render as full-size buttons because every declaration they carry is also declared by `.btn` in a sheet that wins — are removed along with the class names in the markup, so nothing in the tree claims a small button that is not one. Zero pixels move. This is the corrective half of finding 74's note, which established that 32px, not 
  - approach: control.css:71 is `.btn-small { padding: 3px 7px; font-size: 11px; }` and evals.css:119 is `.skills-btn-sm { padding: 4px 9px; font-size: 11.5px; border-radius: 6px; }`. Both sheets are @imported by index.css (lines 13 and 18), so they land above index.css's own `.btn` block (index.css:281-290, which declares `padding`, `font-size` and `border-radius`) and every one of their declarations loses at equal specificity — I verified this by extracting single-class rules from both sheets and intersecting their property sets with `.btn`'s, on class combinations that actually appear in a rendered `clas
  - verify: `node scripts/check-renderer-style.cjs` passes with the two lowered FONT_PX rows and `grep -rn 'btn-small\|skills-btn-sm' src/renderer/src` returns nothing. Before/after screenshots of Control's goal detail card (Copy goal link, release, Create goal, Dismiss, Checkpoint, Claim) and the Skills reader
- **Give .chip and .seg a coarse-pointer target** `small` · _perf-and-style_
  - files: `src/renderer/src/styles/compact.css`
  - goal: The shared chip and segmented primitives get the same 40px coarse-pointer target the five private chip families already have, so a view is not punished for adopting the primitive, and the two selectors naming a component that no longer exists are removed.
  - approach: compact.css:69, inside `@media (pointer: coarse)`: change `.tabs button, .fleet-chip, .fleet-segbtn, .sc-preset, .gt-chip, .skills-chip, .skills-chip-clear, .pg-expand { min-height: 40px; }` to `.tabs button, .chip, .seg button, .fleet-chip, .sc-preset, .gt-chip, .skills-chip, .skills-chip-clear, .pg-expand { min-height: 40px; }`. `.chip` is 26px (`min-height: var(--control-h-sm)`, ui.css:29) and `.seg button` is 22px (`calc(var(--control-h-sm) - 4px)`, ui.css:48), with no coarse-pointer override anywhere; compact.css is last in main.tsx, so it wins at equal specificity. Then delete the two de
  - verify: Do NOT fold this into the existing tablet check at smoke3.ts:2829-2846 as the original plan proposed — that assertion's message is about the session picker and terminal width, and appending chip claims to it would make the printed sentence describe something it no longer only tests. Add a sibling `c
- **Count open candidates instead of subtracting item counts** `medium` · _honesty_
  - files: `src/main/learning/types.ts`, `src/shared/types.ts`, `src/main/learning/ledger.ts`, `src/renderer/src/views/Learning.tsx`
  - goal: The Inbox stage's "awaiting a decision · last Nd" figure is a windowed count of candidates that are actually still open, rather than `candidatesCreated - autoPromoted` — a subtraction that never removes an approved or rejected row and subtracts a COUNT(DISTINCT knowledge_versions.item_id) from a COUNT over knowledge_candidates, which are different units.
  - approach: CORRECTION to the plan this replaces: `LearningPipelineStats` is declared TWICE — src/main/learning/types.ts:540 (interface, used by main) and src/shared/types.ts:2045 (type, imported by the renderer as @shared/types and by the preload at index.ts:602). Adding the field to only the main copy leaves `p.awaitingDecision` a compile error in Learning.tsx. Both must be edited.  1. src/main/learning/types.ts — after `candidatesCreated` (546) add: ```ts   /**    * Candidates created in this window that are still open for a decision:    * status pending or snoozed. Counted directly rather than derived
  - verify: In src/main/smoke4.ts beside the existing `pipelineStats({ windowDays: 7 })` check (~465): create one candidate and decide it (`reviewCandidate(id, 'reject')` — verified legal from 'pending' at repository.ts:368-373), create a second and leave it pending, then assert `pipelineStats({ windowDays: 7, 
  - migration: none — awaitingDecision is a computed COUNT over an existing table and column. Additive to a serialized type: no stored row changes shape, and no read of an old database returns a different answer than a new one would.
- **Add the observed-sessions consent switch to Settings › Privacy** `medium` · _dead-subsystems_
  - files: `src/renderer/src/views/Settings.tsx`, `src/main/index.ts`
  - goal: The observed lane can be switched on. `observed.setEnabled` has zero renderer callers today, so a subsystem that is off by default is off permanently. With the next phase this closes both halves of the finding.
  - approach: `src/main/index.ts:2264`: harden the channel — `handle('observed:setEnabled', (on: unknown) => observed.setObservedEnabled(on === true));`. `handle` is typed `(...args: never[]) => T`, and `never` is assignable to `unknown`, so this compiles; it moves the coercion to the trust boundary rather than leaving it to a truthy `? :` inside the module.  `src/renderer/src/views/Settings.tsx`: add `function ObservedSessions()` immediately after `function Observation(...)`, built only from the file's own house helpers — `Section`, `Toggle`, `Frame`, `useLoad`, `Callout`, `Result`, `msg` (all local, verif
  - verify: Extend the existing observed wiring check at smoke3:2516 rather than adding a second: `check(/handle\(\s*'observed:list'/.test(mainSrc) && /handle\(\s*'observed:state'/.test(mainSrc) && /handle\(\s*'observed:setEnabled'[\s\S]{0,80}on === true/.test(mainSrc) && /observed:\s*\{/.test(preloadSrc) && se

### Wave 7 — 7 phases

- **Stop the Schedules action row mixing button heights** `small` · _perf-and-style_
  - files: `src/renderer/src/views/Schedules.tsx`, `scripts/check-renderer-style.cjs`
  - goal: The four buttons in a schedule's action row are all one height. Today Pause/Resume and History are 32px `.btn` with inline `btn-sm` padding, sitting beside Edit (`btn btn-sm`) and Delete… (`btn btn-danger btn-sm`) at 26px.
  - approach: Two edits, both in the `.sc-actions` row (schedule.css:40, `display: flex`). Schedules.tsx:716 and :726: replace `className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}` with `className="btn btn-sm"` and delete the style prop. `.btn-sm` (index.css:291) is exactly `min-height: var(--control-h-sm); padding: 3px 9px; font-size: var(--t-small)` — the inline copies reproduce two of the three declarations and drop the one that matters, so those buttons keep `.btn`'s 32px `min-height` from index.css:283. This is deliberately the minimal scope: the same inline pattern appears at ro
  - verify: Screenshots of Schedules with at least one session schedule and one non-session schedule (so the Edit button renders), both themes, before and after — the four buttons must share a baseline and a height. `node scripts/check-renderer-style.cjs` must show views/Schedules.tsx at 23 inline style objects
- **Arm and disarm goal autopilot from the Control goal card** `medium` · _dead-subsystems_
  - files: `src/renderer/src/views/Control.tsx`, `src/renderer/src/styles/control.css`
  - goal: `control.setAutopilot` gets its first caller, so the fully built unattended-dispatch lane — the `node` queue runner at index.ts:1054, the sweep timer at index.ts:1074, the budget precondition, the never-dispatched review task and the halt-with-reason — can actually be turned on, and the Settings dispatcher row that already offers a concurrency limit for it stops describing something no screen can 
  - approach: Settings.tsx is deliberately **not** in this phase's file list — the one-line `KIND_COPY` copy edit the author put here moves to the MCP phase, which already owns that file. That removes the only cross-contention between the Control chain and the Settings chain.  `src/renderer/src/views/Control.tsx` — add `SectionHead`, `Hint`, `ConfirmNote` and the `MarkSpec` type to the existing bits import (all verified exported: bits.tsx:265, 438, 206, 59); `Mark`, `Note`, `ago`, `usd` are already there. Add `DocketAutopilot` to the `@shared/types` type import. Control.tsx's inline-style baseline is 0, so 
  - verify: In the wiring block: `check(/handle\(\s*'control:setAutopilot'/.test(mainSrc) && controlViewSrc.includes('window.wanigan.control.setAutopilot(') && controlViewSrc.includes('window.wanigan.control.setBudget(') && controlViewSrc.includes('Arm autopilot'), 'goal autopilot can be armed and disarmed from
- **Close projects:add: the renderer cannot widen managedRoots** `medium` · _trust-boundary_
  - files: `src/main/automation.ts`, `src/main/index.ts`, `src/preload/index.ts`, `scripts/shots.mjs`, `CONTRIBUTING.md`
  - goal: The allowlist every other guard reads stops being writable from the renderer. `managedRoots()` (roots.ts:71-78) is `listProjects().map(p => p.path)` unioned with main-derived worktree and session rows, and its header states the premise — "Both come from this process's own records, never from the caller" — while `projects:add` took a bare path and INSERTed it (`addProject`'s only refusal, `assertWh
  - approach: The working tree currently answers this with `await dialog.showMessageBox` at index.ts:1455-1474. Delete it: on macOS that is a window-modal sheet, nothing in the harness dismisses it, and `scripts/shots.mjs:63` awaits `window.wanigan.projects.add(repo)` inside a `page.evaluate` whose promise then never settles — the seed's own `catch` cannot fire on a hang — while CONTRIBUTING.md:100-103 requires that script for every UI change. Replace it with an argv gate. (1) New file `src/main/automation.ts`, following the shape `daemon.ts:14` already uses: `export const AUTOMATION_ARGV = '--wanigan-autom
  - verify: In `src/main/smoke3.ts`, import `automationRun` from `./automation` and add a behavioural pair: `check(automationRun([]) === false && automationRun(['.', '--user-data-dir=/tmp/x']) === false && automationRun(['--wanigan-automation']) === true, 'automation mode is an explicit argv flag, so a normal l
- **Offer only the effort and permission modes the profile declares** `medium` · _sessions-and-launch_
  - files: `src/shared/launch-fields.ts`, `src/shared/types.ts`, `src/main/providers.ts`, `src/renderer/src/components/NewSessionDialog.tsx`
  - goal: The New session dialog stops offering Codex the reasoning effort `ultra` that the profile's own compiler rejects, stops hardcoding `PERMISSION_MODES` and `EFFORT_LEVELS` where a profile declares its own, and starts honouring a pack's declared `defaultValue` and `allowCustom` — reaching, for effort and permission mode, the same contract the Headless page already keeps. It does this with no new IPC,
  - approach: Add `allowCustom?: boolean` to `ProviderLaunchField` in src/shared/types.ts (:128-136) — the field already exists on the manifest schema (provider-packs.ts:84), is already validated as a boolean (:372), and already governs launch (:924 `if (field.kind === 'select' && field.allowCustom !== true)`); it is simply not projected to the renderer. Project it by adding `allowCustom: field.allowCustom,` to the launchFields map in `detectProviders()` (providers.ts:738-744). New src/shared/launch-fields.ts exports `export type LaunchFieldChoices = { kind: 'select' | 'text'; choices: { value: string; labe
  - verify: In smoke11, a `say('── launch fields · the profile is the contract')` group importing `launchFieldChoices` from '../shared/launch-fields', driven with fabricated `Pick<ProviderInfo,'supports'|'launchFields'>` values copied from the shipped manifests. Codex-shaped (supports `{model:true,effort:true,p
  - migration: none. `allowCustom` on `ProviderLaunchField` is an added optional field on a type the renderer only reads; no manifest, profile fingerprint or stored row changes, and docs/provider-packs.md:126 already documents `allowCustom` in the manifest table, s
- **Stop promising delivery on a queue whose session has exited** `medium` · _sessions-and-launch_
  - files: `src/shared/composer-queue.ts`, `src/renderer/src/components/Composer.tsx`, `src/renderer/src/styles/composer.css`
  - goal: A message queued on a session that then exits says it was not sent instead of promising delivery forever, its 'send now' button stops silently discarding the text, and the two-second `attention.list` + `sessions.list` poll stops on an observed exit or an observed disappearance — without ever deleting queued text because one list read came back short.
  - approach: Create src/shared/composer-queue.ts and move `ComposerSendState` and `deriveSendState` there from Composer.tsx:30-62 byte-identically — a grep across src/ confirms nothing outside Composer.tsx imports them (Sessions.tsx:7 takes only the default export) — so the send rule and the new watcher rule are both drivable from the main-process smoke suite the way shared/palette.ts is. Add the watcher rule there, and make it distinguish three states rather than two, because the finding's own correction rules out the naive guard: `sessionListEntries()` maps `listSessions()`, which returns every entry in 
  - verify: In smoke12, a `say('── composer queue · a queue on an exited session says so, and stops polling')` group importing from '../shared/composer-queue'. `deriveSendState({ status: 'exited', attention: 'idle' })` has `mode === 'blocked'` and a non-null `reason`; `deriveSendState({ status: 'running', atten
  - migration: none. The queue has always been in-memory and deliberately does not survive a quit; nothing persisted changes.
- **Refuse manifest process-source reads of ambient credentials** `small` · _trust-boundary_
  - files: `src/main/provider-packs.ts`, `docs/provider-packs.md`
  - goal: A manifest stops being able to read a credential out of Wanigan's own environment. `parseEnvironment` runs `forbiddenProviderEnvironment` on the destination name only (provider-packs.ts:444); the `source: 'process'` branch at :458-461 validates the name's shape and nothing else, and the production registry compiles with the real `process.env` (:936, providers.ts:314), so :975 reads whatever the ma
  - approach: In `src/main/provider-packs.ts`, beside `forbiddenProviderEnvironment` (:55-68), add a second, deliberately narrow predicate. Do NOT reuse `forbiddenProviderEnvironment` for source names: it refuses the whole `WANIGAN_` prefix, and the built-in GLM and DeepSeek packs read `WANIGAN_GLM_BASE_URL`, `WANIGAN_GLM_MODEL`, `WANIGAN_GLM_SMALL_MODEL` and the DeepSeek equivalents (:812-818, :838-843); `validateProviderPackManifest` fails a whole manifest on any error and an invalid built-in is dropped at :1201-1203, so that route would silently remove both shipped packs from the launcher. Instead add `c
  - verify: In `src/main/smoke4.ts`, beside the existing `preloadManifest`/`nativeLoaderManifest` assertions (1119-1141), add three refusals built from the same base `manifest` in the same `{ ...manifest, id, profiles: [{ ...manifest.profiles[0], id, environment }] }` shape those already use: `{ X_TOKEN: { sour
- **Keep a half-built batch run through a tab switch** `medium` · _state-and-errors_
  - files: `src/renderer/src/views/Batches.tsx`
  - goal: Switching tabs mid-build no longer throws away the run builder: Batches reopens on the page you were on, the New run form comes back with the name, prompt, model and source you had typed, and the run list comes back expanded and at the offset you left.
  - approach: In src/renderer/src/views/Batches.tsx add `import { useViewMemory, useRememberedScrollRef } from '../components/viewMemory';`. (1) Line 121, in `Batches`: `const [view, setView] = useViewMemory<{ page: 'list' } | { page: 'new' } | { page: 'detail'; id: string }>('page', { page: 'list' })`. The seed effect at 124 still forces `{ page: 'new' }` on mount when a seed is present, which is right — a handed-over file list is an explicit request. (2) Line 356, in `NewRun`: `const [cfg, setCfg] = useViewMemory<RunConfig | null>('newRunCfg', null)`. The boot effect at 369-401 needs no change: its no-see
  - verify: The trailing pin phase asserts `batchesSrc.includes("useViewMemory<RunConfig | null>('newRunCfg', null)")` and matches `/const leave = \(\) => \{\s*setCfg\(null\);\s*onCancel\(\);/` on batchesSrc (a regex, not a literal, so re-indentation does not break the pin). Manually: half-fill New run, ⌘1 to S

### Wave 8 — 7 phases

- **Move the unread count into main, and say what it counts** `medium` · _sessions-and-launch_
  - files: `src/shared/unread.ts`, `src/shared/types.ts`, `src/main/sessions.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/views/Sessions.tsx`, `src/renderer/src/views/Fleet.tsx`
  - goal: The unread badge counts output that arrived while you were elsewhere and survives leaving the view, because main owns the number; `bumpUnread` gains its first caller since the initial commit, `sessions:markRead` stops provably no-opping, and Fleet's pill renders for the first time — under wording that matches what the number actually measures. The per-chunk full-list broadcast the naive design wou
  - approach: New src/shared/unread.ts holds both halves so main and the two views cannot drift: `export function shouldBumpUnread(input: { sessionId: string; focusedSessionId: string | null; status: SessionStatus }): boolean { return input.status !== 'exited' && input.sessionId !== input.focusedSessionId; }` and `export function applyUnreadCounts(sessions: readonly Session[], counts: Record<string, number>): Session[]` which returns the SAME array reference when nothing moved (the identity-preserving return the old flush relied on, so an unchanged array still skips the rail re-render). In src/main/sessions
  - verify: In smoke11, a `say('── unread · main owns the count, and the words match what it counts')` group. Behavioural, importing from '../shared/unread': `shouldBumpUnread({ sessionId: 'a', focusedSessionId: 'a', status: 'running' }) === false` — "the session you are looking at never raises its own badge"; 
  - migration: none. `unread` lives only on the in-memory `Live.meta`; no column is added and `session_log` is untouched.
- **Remember Git's pane, project, filter, message and selection** `medium` · _state-and-errors_
  - files: `src/renderer/src/views/Git.tsx`
  - goal: Returning to Git puts you back on the same repository, the same changes/branches/stash pane, the same commit filter, the same half-typed commit message, the same selected row with its diff re-fetched, and the same scroll offsets.
  - approach: In src/renderer/src/views/Git.tsx, on top of the reconcile phase. Import { useViewMemory, useRememberedScrollRef } from '../components/viewMemory'. (1) Swap six useState calls for useViewMemory, keeping every current default: line 110 `projectId` → `useViewMemory('projectId', projects[0]?.id ?? '')`, 126 `sel` → `useViewMemory<Sel>('sel', null)`, 129 `commitFilter` → `useViewMemory('commitFilter', '')`, 131 `msg` → `useViewMemory('commitMsg', '')`, 135 `showAll` → `useViewMemory('showAll', true)`, 136 `pane` → `useViewMemory<'changes' | 'branches' | 'stash'>('pane', 'changes')`. A half-typed c
  - verify: The trailing pin phase asserts `gitViewSrc.includes("useViewMemory<Sel>('sel', null)")`, `gitViewSrc.includes("useViewMemory('commitMsg', '')")` and ``gitViewSrc.includes('useRememberedScrollRef(`panel:${pane}`)')``. Manually, in both themes: open a commit diff, switch to the branches pane, filter t
- **Remember which Learning tab and panel position you left** `small` · _state-and-errors_
  - files: `src/renderer/src/views/Learning.tsx`
  - goal: Learning reopens on the tab you were reading — Inbox, Knowledge, Context or Experiments — at the offset you left it, instead of snapping back to Overview and the top.
  - approach: In src/renderer/src/views/Learning.tsx add `import { useViewMemory, useRememberedScrollRef } from '../components/viewMemory';`. Replace line 299 `const [tab, setTab] = useState<LearningTab>('overview')` with `useViewMemory<LearningTab>('tab', 'overview')`. Every existing writer keeps working: the one-shot deep-link effect at 405-410 (its `consumedTargetNonce` is module-level, so a remount cannot replay a stale jump over a remembered tab), `navigate` at 439-442, and the experiments-vanished guard at 473-475, which still hands a reader back to Overview when a remembered 'experiments' tab has no 
  - verify: The trailing pin phase asserts `learningSrc.includes("useViewMemory<LearningTab>('tab', 'overview')")` and ``learningSrc.includes('useRememberedScrollRef(`panel:${tab}`)')``. Manually, in both themes: open Inbox, scroll, switch to Git and back — Inbox at the same offset; switch Inbox → Overview → In
- **Ratchet modifiers shadowed by index.css in the sheets it imports** `medium` · _perf-and-style_
  - files: `scripts/check-renderer-style.cjs`
  - goal: The failure mode this cluster just fixed by hand becomes measurable: a rule in a sheet index.css `@import`s that declares a property index.css itself declares, on an element that actually carries both classes, is counted, baselined, and can only ratchet down. Closes finding 25's stated impact — 'any future .pane modifier written in a feature sheet will fail the same way, invisibly' — which the fix
  - approach: Add check 5, `SHADOWED_MODIFIER_BASELINE`, keyed by sheet basename like FONT_PX_BASELINE, and extend the header comment's list of four checks to five. Drop the original plan's `sheetRank()` step entirely — no main.tsx parsing, no rank inference. After the cascade phase, the rule that makes this check sound is a CSS law rather than an import order that could change: `@import` must precede other rules, so a sheet index.css imports can never sit below index.css's own declarations. Scope the check to exactly that set. Algorithm, all regex, no new dependency, matching the file's existing style: (1)
  - verify: `node scripts/check-renderer-style.cjs --print-baseline` prints the new section; paste those numbers in and re-run so the gate passes. Then prove the check bites: temporarily add `.pg-head { align-items: baseline; }` back to queue.css and confirm the gate fails with `modifier shadowed by a base rule
- **Pin the ps start-time probe to LC_ALL=C and split "not listed" from "unparsed"** `small` · _tests-and-parsers_
  - files: `src/main/observed.ts`
  - goal: processStarts() no longer depends on the operator's LC_TIME, and a pid that ps listed but whose lstart did not parse survives as an unverified row instead of being dropped under a comment that blames an exit the code cannot observe.
  - approach: WHY THIS IS MORE THAN A LATENT BUG. Verified on this machine: `ps -o pid=,lstart=` prints `71444 Sat Sep  5 21:05:04 2026` under the default locale and `71444 六  9月/ 5 21:05:04 2026` under LC_TIME=zh_CN.UTF-8 (`suббота,  5 сентября …` under ru_RU); `Date.parse` returns NaN for both localised forms, and `locale -a` here lists six zh_CN entries. So today, on an operator whose LC_TIME is any of these, `starts.get(pid)` is `undefined`, `listObserved` hits `continue`, and every observed session disappears — AND the existing smoke assertion at smoke3:1768 (`row !== undefined`) would fail. This fix m
  - verify: `npm run smoke`: phase 27 prints four new ticks and the existing `row?.verified === true` assertion (smoke3.ts:1770) still passes. Prove the pin can fail: `locale -a | grep -i zh_CN` (six entries on this machine), then remove `env: { ...process.env, LC_ALL: 'C' }` from observed.ts, re-run, confirm t
- **Design a goal’s task graph in the Control create card** `large` · _dead-subsystems_
  - files: `src/renderer/src/components/PlanEditor.tsx`, `src/renderer/src/views/Control.tsx`, `src/renderer/src/styles/control.css`
  - goal: A goal can be given a real task graph — parallel implement tasks with disjoint claims, a fan-in review — instead of the fixed four phases every docket gets today. The validator, the cycle check, the terminal-review rule and the claim-overlap rule are all built and covered in main; this is the half that lets anyone reach them.
  - approach: New `src/renderer/src/components/PlanEditor.tsx` — unlisted in the gate's baseline, so zero `style={{` objects: `export type PlanRow = { kind: DocketNodeKind; title: string; instructions: string; dependsOn: number[]; claimPath: string };` `export const planRowsFromDefault = (): PlanRow[] => DEFAULT_DOCKET_PLAN.map((n) => ({ kind: n.kind, title: n.title, instructions: n.instructions, dependsOn: [...(n.dependsOn ?? [])], claimPath: n.claimPath ?? '' }));` — both fields are optional on `DocketPlanNode`, so the `??` guards are required, not defensive. `export const toPlanNodes = (rows: PlanRow[]):
  - verify: In the wiring block: `const planEditorSrc = sourceOf('src/renderer/src/components/PlanEditor.tsx'); check(controlViewSrc.includes('<PlanEditor') && controlViewSrc.includes('toPlanNodes(plan)') && planEditorSrc.includes('DOCKET_NODE_KINDS') && planEditorSrc.includes('DEFAULT_DOCKET_PLAN') && planEdit
- **Show recorded MCP tool calls, and point the dispatcher row at Control** `small` · _dead-subsystems_
  - files: `src/renderer/src/views/Settings.tsx`, `src/renderer/src/styles/settings.css`
  - goal: `mcp.status` gets its first caller: the MCP panel says how many tool calls each configured server has on record and when one last completed — already counted from the hook bus, already smoke-covered — captioned so it reads as a record of use and never as a health check. The comment describing the deleted `mcp_status` table stops describing code that no longer exists, and the dispatcher row names t
  - approach: `src/renderer/src/views/Settings.tsx`, in `function Mcp(...)` (line 3177): - Replace the stale comment above the `servers` load (3193-3199). It currently says "There were Connection and Calls columns here reading mcp_status, and nothing in the app has ever written that table — registry.ts's noteConnection and noteToolCall have no callers". Verified: `mcp_status`, `noteConnection` and `noteToolCall` no longer exist anywhere in `src/` — db.ts:372 and registry.ts:596 both carry the gravestone. Replace it with a comment describing what is now shown: use is counted from `session_events` on the hook
  - verify: In the wiring block: `check(/handle\(\s*'mcp:status'/.test(mainSrc) && /status:\s*\(\)\s*=>\s*call/.test(preloadSrc) && settingsSrc.includes('window.wanigan.mcp.status()') && settingsSrc.includes('Calls on record') && settingsSrc.includes('a floor and not a total') && settingsSrc.includes('no call i

### Wave 9 — 7 phases

- **Move “Blur terminals too” into the settings table** `medium` · _state-and-errors_
  - files: `src/main/demo.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/views/Settings.tsx`
  - goal: The terminal blur is a durable preference read back at start-up, so demo mode no longer comes back half-masked after the reload demo:set performs itself: names are fake and the terminal is blurred, or neither is.
  - approach: The flag is written by DemoPanel into localStorage (Settings.tsx:4439, 4446) and applied by an effect inside DemoPanel (4445), which only exists while Settings › Demo mode is on screen — and the blur checkbox is itself inside `{state.on && …}` — so after `demo:set` reloads the window nothing re-applies `data-demo-blur` (index.css:1029-1031). Make it a stored preference on a validated channel, the way theme already is. (1) src/main/demo.ts: add `export function demoBlur(): boolean { return getSetting('demo_blur_terminals', '0') === '1'; }`, `export function setDemoBlur(on: unknown): boolean { i
  - verify: The smoke3 assertions in step 6 — behavioural for the setting, its rejection of a non-boolean, and the state shape; source-string for the two things that must not come back and the one that must exist. Manually, in both themes: turn on demo mode, tick Blur terminals, quit and reopen Wanigan — the te
  - migration: A new `demo_blur_terminals` row in the existing settings key/value table (settings.ts:21-30 is a plain get/set over `settings(k,v)` with an upsert). Additive: absent means off, which is the current default; no schema statement changes and no existing
- **Have cancelMcpTask report what it did, and let Control say it** `medium` · _visual-and-copy_
  - files: `src/shared/types.ts`, `src/main/control.ts`, `src/renderer/src/views/Control.tsx`
  - goal: Control's 'cancel' stops being a bare lowercase button that silently kills a running agent, and stops replacing that silence with a guess. cancelMcpTask returns what it actually changed — record closed, task canceled, session stopped, claims released — and the button, its title, its confirmation and its result note are all built from that observation.
  - approach: This is a phase of its own because the truthful sentence cannot be written in the renderer. `act(key, work, message)` (Control.tsx:135-140) evaluates `message` before `work` runs, and the node status it would read is a snapshot from the last `load()`. A running agent that exits in between flips its node to 'failed' (control.ts:949), after which cancelMcpTask (control.ts:764-781) marks only the MCP record and releases nothing — so a pre-read past-tense 'its file claims were released' is a guess presented as fact, which is the exact failure CLAUDE.md forbids. Make main report instead. shared/typ
  - verify: Assertions land in the pin phase, including the first behavioural one for this function. In this phase: `npm run typecheck`, the style gate, `npm run smoke`, and a manual pass on a goal with a running implement node — press Cancel task, confirm the ConfirmNote names the task and the agent, confirm t
  - migration: none — no table, column or stored value changes. The only compatibility surface is the IPC return shape, and `control:cancelMcpTask` has exactly one caller in the tree (Control.tsx:271) and no smoke assertion.
- **Give Fleet's sort, filter and scroll position a memory** `small` · _state-and-errors_
  - files: `src/renderer/src/views/Fleet.tsx`
  - goal: Leaving Fleet for a terminal and coming back no longer resets the segmented sort to 'attention', the status filter to 'all' and the card grid to the top.
  - approach: In src/renderer/src/views/Fleet.tsx add `import { useViewMemory, useRememberedScrollRef } from '../components/viewMemory';`. Replace line 140 `const [sort, setSort] = useState<SortKey>('attention')` with `useViewMemory<SortKey>('sort', 'attention')` and line 141 `const [only, setOnly] = useState<AttentionKind | 'all'>('all')` with `useViewMemory<AttentionKind | 'all'>('only', 'all')`. Every existing writer is unchanged: `<Segmented label="Sort sessions by" value={sort} onChange={setSort}` at line 381 type-checks because Segmented is `<V extends string>` with `onChange: (v: V) => void` (bits.ts
  - verify: The trailing pin phase asserts `fleetViewSrc.includes("useViewMemory<SortKey>('sort', 'attention')")` and `fleetViewSrc.includes("useRememberedScrollRef('pane')")`. Manually, in both themes: set sort to 'spend', filter to a status, scroll, press ⌘1 then the Fleet chord — all three come back.
- **Name the token estimator and the observation count for what they are** `small` · _honesty_
  - files: `src/renderer/src/views/Learning.tsx`, `src/renderer/src/components/SessionLearning.tsx`, `src/main/learning/ledger.ts`
  - goal: Four user-visible strings and three comments stop describing the shared estimator as "bytes÷4" — src/shared/tokens.ts computes a character-class heuristic with three densities (prose 4.0, code 2.8, wide 1.2 chars/token) and documents itself as "a character-class heuristic, not a tokenizer". At the same time all THREE sites that call a repetition counter a count of distinct observations are correct
  - approach: Copy only — no logic, no CSS, no new inline style (Learning.tsx baseline 9, SessionLearning.tsx baseline 6; both must stay at or below).  The estimator — four visible strings plus three comments, all verified at these exact lines: - Learning.tsx:109 comment → `/* Token deltas come from the shared character-class estimator, so they always wear the mark and the word. */` - Learning.tsx:1112 → `{estTokens(pendingEst)} across {pending.length} pending proposal{pl(pending.length)} (character-class estimate, never a tokenizer) — decided in the Inbox.` - Learning.tsx:1526 → `<span><b>{estTokens(candid
  - verify: `node scripts/check-renderer-style.cjs` (views/Learning.tsx must stay ≤9 inline style objects, components/SessionLearning.tsx ≤6) and `npm run typecheck`. Then `grep -rn 'bytes÷4\|distinct observation\|Distinct observations' src/` must return nothing. Then `npm run smoke` — smoke4.ts:452 is the asse
  - migration: none.
- **Route the live control bars by the frozen harness** `medium` · _sessions-and-launch_
  - files: `src/shared/provider-status.ts`, `src/renderer/src/views/Sessions.tsx`, `src/main/sessions.ts`
  - goal: The bars above a running terminal are chosen by the session's frozen harness rather than by a hardcoded profile id: a codex-harness pack profile keeps the Codex bar instead of a dead Claude effort slider, a generic-cli pack can no longer send `/effort high` into a CLI Wanigan has never verified accepts slash commands, main refuses that write by default instead of denylisting one built-in id, and t
  - approach: Add to src/shared/provider-status.ts, beside `runsClaudeHarness` and reusing its documented legacy-row fallback: `export function runsCodexHarness(session: Pick<Session, 'harnessId' | 'providerId'>): boolean { return session.harnessId ? session.harnessId === 'codex' : session.providerId === 'codex'; }` and the single routing decision `export function liveControlsFor(session: Pick<Session, 'harnessId' | 'providerId' | 'status'>): 'claude' | 'codex' | 'none' { if (session.status !== 'running') return 'none'; if (runsCodexHarness(session)) return 'codex'; if (runsClaudeHarness(session)) return 'c
  - verify: In smoke11, a `say('── live controls · routed by the frozen harness, never by the profile id')` group. `liveControlsFor` truth table: `{harnessId:'claude-code',providerId:'glm',status:'running'}` → `'claude'`; `{harnessId:'codex',providerId:'codex-work',status:'running'}` → `'codex'` — "a codex-harn
- **Refuse editorExtensions in local provider manifests** `small` · _trust-boundary_
  - files: `src/main/provider-packs.ts`, `docs/provider-packs.md`
  - goal: A local manifest loses its last route to selecting an executable by filesystem path. Discovery refuses `fallbackPaths` for local packs (provider-packs.ts:1287-1292) but says nothing about `editorExtensions`, and `expandFallbacks` walks that field for every source with no `profile.source` guard — the sibling skip at :902-908 covers only `fallbackPaths`, and its own comment says the intent is fail-c
  - approach: Two edits in `src/main/provider-packs.ts` plus the doc. (1) In the local-discovery loop, immediately after the `fallbackPaths` refusal at :1287-1292, add the sibling inside the same `for (const profile of manifest.profiles)`: `if (profile.command.editorExtensions?.length) { errors.push(`${profile.id}: local packs cannot select an executable by editor-extension path. ` + 'Install the dedicated provider CLI on PATH instead.'); }` — a non-empty `errors` forces `status: 'invalid'` and blocks `enabled`, so this is the enforced half. (2) In `expandFallbacks` (:876-911), hoist the local skip to the t
  - verify: Two behavioural blocks in `src/main/smoke4.ts`, beside the existing `compatibilityRegistry` block (1149-1176) which is the same shape. (1) The refusal: create `const editorExtRoot = path.join(tmp, 'provider-packs-editorext')` and, inside it, a directory named exactly `orbit.editorext` (manifestLocat
- **Read the catalog row's real source field, and name it before install consent** `medium` · _tests-and-parsers_
  - files: `src/main/plugins.ts`, `src/renderer/src/views/Plugins.tsx`
  - goal: catalog() stops reading `source.repo` — a key `claude plugin list --json --available` emits on zero rows — and reads the `url` the CLI actually sends; the value stops being dead wiring by appearing in the install-confirmation prompt, which is the one place knowing where the code comes from changes a decision.
  - approach: DO NOT TOUCH plugins.ts:239-243. There is a SECOND `src.repo` read in this file — the `known_marketplaces.json` reader inside the disk scan — and it already falls back `repo → url → source → '—'`. It reads a different file with a different shape and is not the defect. Only the catalog mapper at plugins.ts:457-459 is.  src/main/plugins.ts:  1. Add above `CatalogPlugin` (:349): ```ts export type PluginSource = {   kind: 'repository' | 'marketplace-path';   value: string;   subpath: string | null;   ref: string | null; };  /** A source string comes from another program's JSON and lands in a conse
  - verify: `npm run smoke` prints the six new catalog assertions plus the wiring line; `npm run typecheck`; `node scripts/check-renderer-style.cjs`; `git diff --check`. Prove the parser assertion can fail by restoring the old `src.repo`-only ternary behind `catalogSource` and confirming the git-subdir assertio

### Wave 10 — 6 phases

- **Give the batch badge its own query instead of all 200 runs** `medium` · _perf-and-style_
  - files: `src/main/batch/index.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`
  - goal: The 6-second shell poll stops asking for 200 full `runs` rows with their `config_json` and 1,000 correlated subqueries in order to render one badge and one progress bar. Behaviour is byte-identical; only the read shrinks.
  - approach: src/main/batch/index.ts, beside `listRuns()` (line 111): add `export type ActiveRunProgress = { id: string; status: string; succeeded: number; failed: number; pending: number };` and `export function activeRunProgress(): ActiveRunProgress[]` running `SELECT r.id, r.status, (SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id AND q.status = 'succeeded') succeeded, (SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id AND q.status IN ('errored','expired','canceled','refused')) failed, (SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id AND q.status = 'pending') pending FROM runs r WHERE r.
  - verify: src/main/smoke3.ts `── wiring`: `check(/handle\(\s*'batch:activeRuns'/.test(mainSrc) && /activeRuns:\s*\(\)/.test(preloadSrc) && appSrc.includes('batch.activeRuns()') && !appSrc.includes('batch.runs()'), 'the shell badge reads a query scoped to flying runs rather than every run ever recorded');` Beh
- **Offer the CLI budget only to the protocol that accepts one** `medium` · _honesty_
  - files: `src/shared/types.ts`, `src/main/providers.ts`, `src/renderer/src/views/HeadlessRuns.tsx`
  - goal: The "CLI budget / repository" field and the header sentence that promises it appear only for a profile whose declared headless protocol has a cost flag. Verified at headless.ts:274-282: `--max-budget-usd` is emitted on the claude-json branch only; the codex-json branch takes the prompt, `exec --json` and nothing else, under an in-code comment that says "Codex has no budget flag of its own". So a C
  - approach: The renderer cannot route on this today: `ProviderInfo` (shared/types.ts:4-23) carries `capabilities.headlessJson` (true for Codex) and `harnessId`, but not the protocol. Carry the declared protocol across the boundary and gate on it — routing by declaration, not by profile id, per CLAUDE.md.  1. src/shared/types.ts — `export type HeadlessProtocol = 'claude-json' | 'codex-json' | 'none';` and on `ProviderInfo`, after `harnessId` (line 20): `/** The unattended invocation protocol this profile declares. 'none' refuses a headless run; the two JSON protocols take different flags, and only claude-j
  - verify: `npm run typecheck` (the required field is the guard that main and the renderer agree) and `node scripts/check-renderer-style.cjs` with views/HeadlessRuns.tsx at 0. Manually: select a Codex profile and confirm the budget box disappears, the Note names the timeout as the only limit, and the header no
  - migration: none. `headless` is a new required field on a serialized-only type built in exactly one place (detectProviders, providers.ts:717); nothing is stored and no database row changes shape.
- **Show sessions started outside Wanigan in Fleet, read-only** `medium` · _dead-subsystems_
  - files: `src/renderer/src/components/ObservedBand.tsx`, `src/renderer/src/styles/observed.css`, `src/renderer/src/views/Fleet.tsx`
  - goal: Fleet stops answering "how many agents are running" with a number that excludes every Claude process launched from a terminal or the VS Code extension — three of them on this machine right now. The band is separate from Wanigan's own counts, offers no channel to a foreign session, and renders four different things for four different states.
  - approach: New `src/renderer/src/components/ObservedBand.tsx`, default-exported, self-contained (it calls `window.wanigan.observed.*` directly and takes no props), with `import '../styles/observed.css'` — the precedent is `components/SessionLearning.tsx:11`, the one component that already imports its own sheet. A new .tsx is unlisted in the gate's baseline, so it must carry **zero** `style={{` objects.  State: `rows: ObservedSession[]`, `state: ObservedState | null`, `err: string | null`, `readAt: number`, `ready: boolean`, `copied: string | null`. Polling effect: `read()` returns early on `document.hidd
  - verify: Add `const observedBandSrc = sourceOf('src/renderer/src/components/ObservedBand.tsx');` to the declaration block at smoke3:2471-2497. Beside the observed wiring assertion: `check(fleetViewSrc.includes('<ObservedBand') && observedBandSrc.includes('window.wanigan.observed.state()') && observedBandSrc.
- **Pin the view-memory, Git and draft contracts in smoke** `medium` · _state-and-errors_
  - files: 
  - goal: Every contract this cluster adds is asserted in the offline main-process suite, so the mechanism cannot go back to being wired with no consumers and the Git reconcile cannot be silently reverted.
  - approach: All of this lands in src/main/smoke3.ts and it must run last, rebasing onto whatever the other two smoke3 phases and other clusters have already added. First, add four sources to the declaration block at 2470-2496 — `gitViewSrc` ('src/renderer/src/views/Git.tsx'), `batchesSrc` ('src/renderer/src/views/Batches.tsx'), `composerViewSrc` ('src/renderer/src/components/Composer.tsx') and `viewMemorySrc` ('src/renderer/src/components/viewMemory.ts') — so the `missingSources.length === 0` check at 2504 covers them, and update the stale "twenty-three files" count in the comment at 2501. Then add a `say
  - verify: `npm run smoke` — the new block passes and fails if any of the eight contracts is reverted. Also run `npm run typecheck` (the shared import is new to main) and `node scripts/check-renderer-style.cjs` for the cluster as a whole; no baseline in that gate should need to move, and any that can be lowere
- **Pin the chrome-and-copy sweep in smoke and ratchet the gate** `small` · _visual-and-copy_
  - files: `scripts/check-renderer-style.cjs`
  - goal: Every fix in this cluster gains a durable assertion in the offline main-process suite, in one new labelled block rather than nine scattered edits to the same file, and the style-gate baselines the sweep paid down are lowered so the debt cannot quietly come back.
  - approach: smoke3.ts — open a new group `say('── chrome and copy')` immediately after the `── wiring` group ends and before `say('-- demo mode')` at line 2947. `cssSrc`, `settingsSrc`, `controlSrc`, `controlViewSrc`, `routesSrc`, `usageViewSrc` and `scoutViewSrc` are already in scope from lines 2471-2497; declare `const controlCss = sourceOf('src/renderer/src/styles/control.css')`, `const gitCss = sourceOf('src/renderer/src/styles/git.css')`, `const gitViewSrc = sourceOf('src/renderer/src/views/Git.tsx')`, `const settingsCss = sourceOf('src/renderer/src/styles/settings.css')`, `const pluginsViewSrc = sou
  - verify: `npm run smoke` — the new group must print ten passes, the phase-30 block two more, and the suite total must rise by twelve; then `node scripts/check-renderer-style.cjs` must still pass against the lowered baselines, and re-running it with `--print-baseline` must show the pasted numbers matching the
- **Replace the single assertion floor with a per-phase floor table** `medium` · _tests-and-parsers_
  - files: 
  - goal: Losing a whole phase fails the run. Today the suite-wide floor of 660 (smoke.ts:232) sits about 150 below the observed count, so smoke2 (104 assertions) or most of smoke4 could stop running and `npm test` would still report success; after this, each phase is measured against its own recorded contribution and a phase deleted from the table fails a separate check.
  - approach: CORRECT THE COMMENT FIRST. The note at smoke.ts:207-212 says the floor backstops "an import dropped". It does not: smoke.ts:185-206 already wraps the whole phase block in a try/catch whose handler is `check(false, 'phase smoke threw: …')`, so a module that fails to load already fails the run. What it backstops is narrower and should be said so: a suite that stops asserting WITHOUT throwing — a deleted call line, an early return, a `say()` group deleted with its assertions, or a phase that catches its own throw and reports one `check(false)` where it used to report ninety (smoke5, smoke10 and s
  - verify: `npm run smoke` twice per the procedure above; the second run must print one floor line per phase plus the prologue floor, the table-size check and the suite-wide check, all green. Then prove each new check can fail, reverting after: (1) comment out `await run(check, say)` for smoke5 and confirm `ru

### Wave 11 — 1 phases

- **Read the model catalogue in main, once, for every backend** `large` · _sessions-and-launch_
  - files: `src/main/launch-choices.ts`, `src/main/index.ts`, `src/main/providers.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/renderer/src/components/NewSessionDialog.tsx`
  - goal: The dialog's model picker is the live backend catalogue intersected with the profile's declared contract, for every profile: GLM and DeepSeek stop shipping stale hardcoded lists while their live fetchers sit unused, the fallback note both fetchers already carry is finally shown, a pack that declares its own models is launchable, and Wanigan runs one Codex model probe instead of two. Effort, permis
  - approach: Add to src/shared/types.ts, beside `ProviderLaunchField`: `export type LaunchModelRow = { value: string; label: string; description: string | null; efforts: string[] | null }` and `export type LaunchModelCatalogue = { rows: LaunchModelRow[]; source: 'declared' | 'live' | 'published' | 'none'; note: string | null }` — in shared, not in a main module, so the preload can type the channel without importing across the trust boundary. Extract `export function launchFieldsFor(def: ProviderDef): ProviderLaunchField[]` in src/main/providers.ts from the inline map now at :738-745, and call it from `dete
  - verify: In smoke11, a `say('── model catalogue · the profile is the contract, the backend is the catalogue')` group driving the pure `resolveModelCatalogue`. A codex-shaped `LaunchFieldChoices` (`kind:'text'`, no declared choices) against a live catalogue row whose `efforts` are `['low','high','ultra']` kee
  - migration: none. `providers:modelCatalogue` is a new read-only channel; two shared types are added; no manifest, profile fingerprint or stored row changes.

### Wave 12 — 4 phases

- **Give permission modes words, and an unknown one an honest label** `small` · _sessions-and-launch_
  - files: `src/shared/types.ts`, `src/renderer/src/components/NewSessionDialog.tsx`
  - goal: The control that decides whether an agent asks before running commands is a list of readable choices rather than six camelCase identifiers, each mode Wanigan can describe carries its description before the choice is made, a mode Wanigan cannot describe says so instead of being relabelled as one the reader already trusts, and the blank 'default' option is not accused of being an unrecognised mode.
  - approach: Add to src/shared/types.ts immediately after `trustGlyph`, mirroring `trustCopy`'s doc comment about why a bare `Record` indexed directly is the bug that helper exists to fix: `const PERMISSION_MODE_COPY: Record<string, { label: string; detail: string }>` (module-private) and `export function permissionModeCopy(mode: string): { label: string; detail: string; known: boolean }`. Returning `known` rather than exporting the table is what keeps the renderer from ever indexing a copy table with a value that came from data — the exact anti-pattern smoke3.ts:2747-2749 pins for `TRUST_COPY`, and `permi
  - verify: In smoke11, a `say('── permission modes · a word before the choice, and an honest unknown')` group. `permissionModeCopy('bypassPermissions').label === 'Ask for nothing'` and `permissionModeCopy('acceptEdits').label === 'Accept edits'`, both with `known === true` — "the two modes the reader must tell
  - migration: none. No manifest, profile fingerprint or stored value changes — only the words shown for a value that was already being stored and passed through.
- **Say "learning is paused", not "retrieval matched nothing"** `medium` · _honesty_
  - files: `src/preload/index.ts`, `src/renderer/src/views/Learning.tsx`
  - goal: With learning switched off, both briefing previews stop reporting a disabled engine as an empty retrieval. Main already answers this correctly — learning-service.ts:1125-1131 returns `learningEnabled: false` plus `harnessId`, `launchDelivery` and `harnessProof` on a `BriefingPreview` — but the preload types the channel as `KnowledgeBriefing` (preload/index.ts:573-574), so the fields that exist to 
  - approach: 1. src/preload/index.ts — add `BriefingPreview` to the type import from '../shared/types' (the block at lines 2-28) and change 573-574 to `call<BriefingPreview>('learning:briefing', input)`. Nothing else on the channel changes; this only stops discarding what main already sends over the wire. 2. src/renderer/src/views/Learning.tsx, `BriefingInspector` (2335):    - add `BriefingPreview` to the `@shared/types` type import (block at lines 2-19); `const [result, setResult] = useState<BriefingPreview | null>(null);` (2344).    - Before the inspector form, a pre-run statement from the `settings` pro
  - verify: `npm run typecheck` must pass with the widened preload type and both retyped components — it is the guard that proves the fields are no longer erased. `node scripts/check-renderer-style.cjs` with views/Learning.tsx still at ≤9. Manually: switch learning off in Context, press Preview, confirm the pau
  - migration: none.
- **Confirm provider-pack manifest and adapter trust in main** `medium` · _trust-boundary_
  - files: `src/main/pack-consent.ts`, `src/main/index.ts`, `docs/provider-packs.md`
  - goal: Execution trust stops being a step the renderer can decline to render. `providerPacks:trustManifest` (index.ts:1398-1401) and `providerPacks:trustAdapter` (:1417-1420) are bare pass-throughs, and provider-packs.ts:1474/:1495 check only that the digest still matches disk, never that a human saw anything. The whole consent surface is renderer-drawn (Settings.tsx:1044 inspect, :1163 the `<pre>`, :117
  - approach: New file `src/main/pack-consent.ts`, so the summary is a pure function the smoke suite can call without a dialog. It imports only types already exported by provider-packs.ts (`ProviderPackRecord` at :186, whose `manifest` and `sourcePath` are both nullable) plus `node:path`, so it does not touch provider-packs.ts and cannot collide with the two phases that do. Exports `export type TrustPrompt = { title: string; message: string; detail: string }`, `export function manifestTrustPrompt(pack: ProviderPackRecord): TrustPrompt` and `export function adapterTrustPrompt(pack: ProviderPackRecord, inspec
  - verify: In `src/main/smoke3.ts`, import `manifestTrustPrompt` and `adapterTrustPrompt` from `./pack-consent` and add a behavioural block. Build a synthetic `ProviderPackRecord` (the type is exported at provider-packs.ts:186) with `source: 'local'`, a real `sourcePath`, a 64-hex `manifestSha256`, and a manif
- **Feed the running-session model picker from the shared catalogue** `small` · _sessions-and-launch_
  - files: `src/renderer/src/views/Sessions.tsx`
  - goal: A running DeepSeek session gets the model switcher its profile supports, the running-session picker stops carrying its own hardcoded table keyed on four built-in profile ids, DeepSeek's shipped `deepseek:models` fetcher is reached for the first time, and the effort slider offers exactly the levels the session's own profile declares.
  - approach: In Sessions.tsx delete the `MODEL_CHOICES` table (:1306-1319) and the `provider.id !== 'glm'` short-circuit effect (:1324-1338) outright. `RunConfigBar` instead holds `const [catalogue, setCatalogue] = useState<LaunchModelCatalogue | null>(null)` filled from `window.wanigan.providers.modelCatalogue(provider.id)` in an effect keyed on `provider.id` with a `live` guard and a catch that leaves it null; `const models = catalogue?.rows ?? []` and `const modelNote = catalogue?.note ?? null`, so the hint line's existing honesty affordance (the `modelNote` branch at :1404-1406) keeps working and now c
  - verify: In smoke11, extend the live-controls group with source strings over `sourceOf('src/renderer/src/views/Sessions.tsx')`: does not contain `const MODEL_CHOICES` and does not contain `provider.id !== 'glm'` — "the running-session picker holds no catalogue of its own and no id short-circuit"; contains `w

### Wave 13 — 2 phases

- **Stop promising a spend ceiling a scheduled fan-out may never get** `medium` · _honesty_
  - files: `src/shared/types.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/views/Schedules.tsx`
  - goal: Schedules stops telling the operator that every repository in an unattended fan-out is "held to the $2.00 per-repository ceiling Wanigan hands the CLI" when the profile that will actually fire accepts no ceiling at all. This is the same defect as the Runs budget field on the path where it matters most — nobody is at the keyboard — and the previous plan missed it entirely.
  - approach: Verified chain: Schedules.tsx takes only `{ projects }` (114) and never sets a providerId, so every headless schedule fires under `defaultHeadlessProviderId()` (index.ts:581-589 — the first installed profile with `capabilities.headlessJson`, which Codex declares). index.ts:986 then passes `SCHEDULED_BUDGET_USD` into a run whose argv is built by `headlessArgs`, which drops it on the codex-json branch. Schedules.tsx mirrors the constant as `PER_REPO_BUDGET_USD = 2` (74) under a comment that itself flags the mirror as fragile, and renders it as a hard promise at 525 ("each held to the $2.00 per-r
  - verify: `npm run typecheck` and the style gate. Manually: with a Codex profile first in the detected list, open Schedules, choose Headless with no repository pinned, and confirm the fan-out warning names the timeout as the only bound rather than a dollar ceiling; with Claude first, confirm the original sent
  - migration: none — one new read-only IPC channel and one serialized type. Nothing is stored and no existing schedule row is reinterpreted.
- **Split the Recent read from the session list read** `small` · _sessions-and-launch_
  - files: `src/renderer/src/views/Sessions.tsx`
  - goal: A SQLite failure inside `pastSessions()` costs the Recent conversations list and nothing else. Live terminals, their tabs and the composer stay on screen, and the view-wide heading 'The session list did not load' is only reachable when the session list actually did not load.
  - approach: In Sessions.tsx add `const [pastErr, setPastErr] = useState<string | null>(null);` beside `listErr` (:169), and split `refresh` (:262-272) into two callbacks declared in dependency order: `const refreshPast = useCallback(async () => { try { setPast(await window.wanigan.sessions.past()); setPastErr(null); } catch (e) { setPastErr(msg(e)); } }, []);` and `const refresh = useCallback(async () => { try { setSessions(await window.wanigan.sessions.list()); setListErr(null); } catch (e) { setListErr(msg(e)); } finally { setReady(true); } await refreshPast(); }, [refreshPast]);`. The two reads are gen
  - verify: In smoke11, a `say('── Recent conversations · its own failure, its own note')` group of source strings over `sourceOf('src/renderer/src/views/Sessions.tsx')`. Assert on exact strings rather than bounded regexes, which are fragile here: contains `const [pastErr, setPastErr]`; contains `const refreshP

### Wave 14 — 2 phases

- **Pin the honesty invariants smoke can only check in source** `medium` · _honesty_
  - files: 
  - goal: The main-process smoke suite carries a durable guard for each claim this cluster corrected, so a later edit that reintroduces one fails a test rather than shipping. The suite has no renderer, so these are source assertions in smoke3's wiring block — the pattern the file already uses for App.tsx, Settings.tsx, Fleet.tsx and Usage.tsx — plus assertions over main-process source for the two launch sit
  - approach: Two mechanical constraints the previous plan got wrong, both verified:  (a) **Declare new sources in the top block, before line 2504.** `sourceOf` returns the sentinel string `'<wanigan: source file not found>'` on a bad path (smoke3.ts:97-107), NOT an empty string — so a mistyped path makes every `!src.includes(…)` assertion pass silently. The `check(missingSources.length === 0, …)` at 2504 is the guard against exactly that, and it only covers sourceOf calls made before it. Add these to the declaration block at 2470-2497, beside `sessionManagerSrc`: ```ts const headlessMainSrc = sourceOf('src
  - verify: `npm run smoke` — all eleven new assertions pass, the suite's failure count stays at 0, the `missingSources.length === 0` check at 2504 still passes with the four new source paths, and the floor at smoke.ts:231 is comfortably cleared. Then, in a scratch copy, revert one changed string per assertion 
  - migration: none — test-only.
- **Show the rest of Recent conversations, and count what is hidden** `small` · _sessions-and-launch_
  - files: `src/renderer/src/views/Sessions.tsx`, `src/renderer/src/styles/sessions.css`, `scripts/check-renderer-style.cjs`
  - goal: The active band of Recent conversations gets the same 'show more' affordance the settled shelf below it already has, plus a count of what is behind it — so the ninth-newest resumable conversation stops being reachable only by settling, pinning or forgetting newer rows — and the renderer says plainly where main's own cap begins. One inline style object is paid off and the ratchet drops with it.
  - approach: Add `const [activeShown, setActiveShown] = useState(8);` beside the existing `settledShown` (Sessions.tsx:212). Change :758 to `{activePast.slice(0, activeShown).map(renderPast)}` and follow it with the control, mirroring the settled shelf's shape at :770-776 but carrying the count: `{activePast.length > activeShown && (<FocusBtn className="faint rail-more" onClick={() => setActiveShown((n) => n + 8)}>Show {Math.min(8, activePast.length - activeShown)} more — {activePast.length - activeShown} not shown</FocusBtn>)}`. Add the honest cap line for when everything the renderer holds is on screen a
  - verify: In smoke11, a `say('── Recent conversations · the ninth row is reachable')` group over `sourceOf('src/renderer/src/views/Sessions.tsx')`: contains `activePast.slice(0, activeShown)` and does not contain `activePast.slice(0, 8)` — "the active band is paged, not truncated"; contains `not shown` — "the

### Wave 15 — 1 phases

- **Warn when a launch enters a checkout another agent is editing** `small` · _sessions-and-launch_
  - files: `src/renderer/src/components/NewSessionDialog.tsx`, `src/renderer/src/views/Sessions.tsx`
  - goal: The New session dialog states the observed fact that agents are already running in the chosen project's own checkout, at the moment the operator is deciding whether to isolate — so the most common way one operator running several agents loses work stops being invisible until a merge or a lost edit surfaces it. It warns; it never refuses.
  - approach: Sessions.tsx already holds the live list and is the dialog's only mount site (:1046-1048), so pass it down: add `liveSessions: Session[]` to the dialog's props — today `providers`, `projects`, `defaultProjectId`, `onClose`, `onCreate`, `onAddProject` — and render `<NewSessionDialog … liveSessions={sessions} />`. In the dialog compute `const sharing = useMemo(() => liveSessions.filter((s) => s.projectId === projectId && !s.worktree && s.status !== 'exited'), [liveSessions, projectId]);` — a session with a `worktree` has its own checkout and is not in the way, which is precisely the escape the i
  - verify: In smoke11, a `say('── launch · two agents in one checkout is stated before the launch, not after the merge')` group of source strings over `sourceOf('src/renderer/src/components/NewSessionDialog.tsx')`: contains `liveSessions.filter((s) => s.projectId === projectId && !s.worktree` — "the warning co

### Wave 16 — 1 phases

- **Re-calibrate the smoke floor to what the suite now runs** `small` · _sessions-and-launch_
  - files: 
  - goal: `MIN_ASSERTIONS` again describes the suite it guards, so a future run that loses a whole phase fails instead of printing '0 failed'. The floor was calibrated at 660 against 673 observed on 2026-09-04 and the suite has grown well past that since; this cluster adds two more modules on top.
  - approach: Run `npm run smoke` once with every other phase in this cluster landed, read the `════ N passed, 0 failed ════` line, and set `MIN_ASSERTIONS` in src/main/smoke.ts to that observed total less a small margin for environment variance — the same shape the existing value uses. Update the comment beside it to record the new observed count and the date, exactly as that comment instructs ("Record the observed count whenever you raise this: a bare number cannot tell the next reader whether it is a real floor or a stale one"). Do not touch anything else in smoke.ts; the two `await import('./smoke11')` 
  - verify: `npm run smoke` reports `0 failed` and a total at or above the newly written `MIN_ASSERTIONS`, and the 'suite coverage' check itself passes. `npm test` passes end to end: typecheck, the renderer style gate (with `views/Sessions.tsx` at its lowered 125), the two packaging suites, and smoke.