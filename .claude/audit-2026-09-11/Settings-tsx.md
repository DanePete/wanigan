# Settings.tsx — 23 findings

## src/renderer/src/views/Settings.tsx:837 — [high] false-assertion-while-unread  (CONFIRMED, sustained 3/3)

**Claim.** The Claude Platform API key panel has only two states where its three hardened siblings have four: it renders "No key stored" (and the label "Paste your key") whenever `status` is null — i.e. on every first paint before `key.status()` lands, and permanently after that read fails — so Wanigan asserts an answer about a credential it never got.

**Evidence.**

```
Settings.tsx:824 `{status?.present ? (` … :837 `<Note tone="warn">No key stored. Batches cannot estimate or submit without one.</Note>` and :841 `<label className="label" htmlFor="anthropic-api-key">{status?.present ? 'Replace key' : 'Paste your key'}</label>`. The file states the rule for the siblings at :907-910 — "Four states, not two. \"No key stored\" is a real answer about your Keychain; a read that never landed or that threw is not, and drawing the second as the first is how this panel offered \"paste a key\" to someone who already had one" — and implements it at :911-922 (`glmStatusError ? <Note tone="error">… : !glmStatus ? <Reading what="the stored Z.ai Coding Plan key" /> : …`), repeated for DeepSeek (:940-951) and xAI (:966-977). The Claude panel has no `statusError` state and no `<Reading>`. The effect at :514 proves a failed read is a live state, and its own comment at :509-512 describes this very render: "the panel then rendered its `status?.present ? … : …` else-branch, offering \"Paste your key\" as though Wanigan had asked and been told there was none" — the catch was added, the render was not.
```

**Failure.** Operator has a Platform key installed and opens Settings → Agents: for the duration of the IPC round trip the panel shows the amber "No key stored. Batches cannot estimate or submit without one." and offers "Paste your key". If `key:status` rejects (Keychain/IPC failure — the path the :514 catch exists for), that state is permanent and the panel renders a self-contradicting pair inside one Section: the amber "No key stored" at :837 above the red "Wanigan could not read whether a key is installed…" at :875, with Verify and Remove withheld so the operator cannot act on the key they actually have.

**Fix.** Give the panel the sibling shape: add a `statusError` state set by the :514 catch, and render `statusError ? <Note tone="error">…</Note> : !status ? <Reading what="the stored Claude Platform key" /> : status.present ? … : <Note tone="warn">No key stored…</Note>`, with the label falling back to "Claude Platform API key" (not "Paste your key") while `status` is null.

---

## src/renderer/src/views/Settings.tsx:1040 — [high] cross-panel-state-bleed  (CONFIRMED, sustained 3/3)

**Claim.** One `msgState` is shared by the Claude Platform API key panel (Agents tab) and the Spending panel (Automation tab), so every message written by either action renders in both places — including in the tab the operator was not using.

**Evidence.**

```
451: `const [msgState, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);`
875 (Agents › Claude Platform API key): `{msgState && <div …><Note tone={msgState.tone === 'ok' ? 'ok' : 'error'}>{msgState.text}</Note></div>}`
1040 (Automation › Spending): `{msgState && <div …><Note tone={msgState.tone === 'ok' ? 'ok' : 'error'}>{msgState.text}</Note></div>}`
1028 (written by the spend-cap Save): `setMsg({ tone: 'ok', text: v > 0 ? \`Runs estimated above $${v.toFixed(2)} will be blocked.\` : 'Spend cap disabled.' });`
Both panels are always mounted — `SettingsTabPanel` renders children unconditionally and only sets `hidden={!active}` (line 404).
```

**Failure.** Set the spend cap to 5 on Automation › Spending and click Save. `setMsg` fires, and a green Note reading “Runs estimated above $5.00 will be blocked.” is now also rendered directly under the “Paste your key” field in Agents › Claude Platform API key. The reverse is worse: paste a bad key and `save()` sets `setMsg({tone:'error', text:'That does not look like a Claude Platform key — they start with "sk-ant-"…'})` (line 630), which renders as a red critical Callout under Spending, reading as a failed spend-cap save. Likewise the mount-time read failure at line 514 — “Wanigan could not read whether a key is installed… What this panel shows below is not an answer about your key.” — renders under the spend-cap field, where “this panel” means the cap.

**Fix.** Give Spending its own message state (e.g. `const [capMsg, setCapMsg]`), write lines 1028/1030 to it, and render `capMsg` at line 1040. Leave `msgState` to the key panel.

---

## src/renderer/src/views/Settings.tsx:1967 — [high] false-status-claim  (CONFIRMED, sustained 3/3)

**Claim.** The Listeners table reports the hook bus as "✓ enabled" from the stored preference alone, while the row directly above it is careful to distinguish a preference from a bound socket — so switching the hook bus on without restarting shows a green enabled mark while no listener exists and every new session is launched with no hook configuration.

**Evidence.**

```
Settings.tsx:1967 `<td><Mark {...(prefs?.hooks ? { glyph: '✓', word: 'enabled', color: 'var(--good)' } : OFF)} /></td>` — derived from `prefs`, with no listener read, unlike the OTLP row at 1958-1962 which renders `'Telemetry is on now, but no port is bound — it was off when Wanigan started, or the socket failed. Restart to open it.'`. `startHookServer()` has exactly one call site, src/main/index.ts:930, inside `if (f.hooks)` at boot; `settings:setPref` (index.ts:3214) only writes the key. hooks.ts:324-326 `if (!hooksEnabled()) return null; const live = info; if (!live) return null;` and sessions.ts:1119-1120 `const settingsFile = writeHookSettings(id0, cwd); if (settingsFile) injected.push('--settings', settingsFile);` — a null is silently skipped. hooks.ts:141 `export function hookServerInfo(): { port: number } | null` is exported and has zero consumers anywhere in src/, and no IPC exposes it.
```

**Failure.** Launch Wanigan with the hook bus off, then turn it on in Settings → Privacy & data → Observation. The Listeners table immediately shows "Hook bus ✓ enabled". Start a Claude Code session: `writeHookSettings` returns null, no `--settings` is passed, and that session records no tool events, no policy-ledger decisions, no per-turn checkpoints and no learning signals — while Settings asserts the listener is enabled and the footnote at 1993-1999 only describes the opposite direction ("the listener stays bound until you restart"). headless.ts:1010-1015 proves this state is known and distinguishable: it logs "the hook listener is not up" as a third cause separate from "Hooks are off in Settings".

**Fix.** Expose `hookServerInfo()` over IPC and render the hook-bus row the way the OTLP row is rendered: bound → ✓ with the port; pref on but `info === null` → ⚠ with "The hook bus is on now, but no listener is bound — it was off when Wanigan started. Restart to open it."; pref off → OFF.

---

## src/renderer/src/views/Settings.tsx:2485 — [high] stale-state  (CONFIRMED, sustained 3/3)

**Claim.** `disconnect()` compares a Tailscale-reported URL against the stored dashboard URL with `===`, but main normalises the stored copy by stripping the trailing slash — so for any mapping Wanigan itself published the branch never runs, `absorb()` is never called, and the panel keeps showing a pairing QR and link for an address Tailscale no longer serves.

**Evidence.**

```
2477: `const served = net.s === 'ok' ? net.d.url : null;`
2485: `if (served && status.config.dashboardUrl === served) {`
2486: `absorb(await window.wanigan.mobile.configure({ dashboardUrl: '' }));`
The comment above it states the intent: “A saved dashboard URL that Serve no longer publishes is a QR that fails silently on the phone, so it leaves with the mapping that produced it.”
Main builds the served URL at `src/main/tailnet.ts:295` — `return \`${origin}${mount}\`` with `mount` = `/` for the `serve --bg <port>` argv Wanigan itself issues (tailnet.ts:369) — i.e. `https://host/`. Main then stores it through `src/main/mobile/config.ts:60` — `return parsed.toString().replace(/\/+$/, '');` — i.e. `https://host`.
```

**Failure.** Click “Connect this Mac”, then “Disconnect”. `served` is `https://mac.tailnet.ts.net/`; `status.config.dashboardUrl` is `https://mac.tailnet.ts.net`; the comparison is false, so `absorb()` never runs and `status` is never re-read. `pairable` (line 2505) stays true, so the panel still renders `<PairingQr url={status.pairingUrl} />` and `<code>{status.pairingUrl}</code>` for `https://mac.tailnet.ts.net/#token=…`, and `PairingQr`'s effect (deps `[url]`, line 2302) does not refire, so even the image is the old code. Main has already cleared the setting itself (`src/main/index.ts:2523`, which uses `sameUrl()` precisely because of the trailing slash), so the operator is shown a pairing link and QR for an address that no longer resolves.

**Fix.** Drop the local repair entirely and just re-read after the transport call — `absorb(await window.wanigan.mobile.configure({}))` or `absorb(await window.wanigan.mobile.status())` — since `tailnet:unserve` (and `tailnet:serve`) already save and clear `dashboardUrl` in main. If the local branch is kept, compare with a trailing-slash-insensitive helper mirroring `sameUrl()`.

---

## src/renderer/src/views/Settings.tsx:4781 — [high] honest-state  (CONFIRMED, sustained 3/3)

**Claim.** An unmeasurable worktree renders as "none" uncommitted and "none" ahead, and the force-delete confirmation is built from those same collapsed values, so it understates what the delete destroys.

**Evidence.**

```
Settings.tsx:4781-4783 — `{w.dirty > 0 ? <span …>{plural(w.dirty, 'file')}</span> : <span className="faint">none</span>}` and 4786-4788 the same for `w.ahead`. The field is already collapsed in main: worktrees.ts:466-467 — `dirty: dirty.count ?? 0, ahead: ahead.count ?? 0,` under the comment "Unknown shows as 0 in the list, which is only a display". `Dirty` is `{count:number;said:null} | {count:null;said:string}` (worktrees.ts:154) precisely because "Collapsing a failed `git status` to 0 was the bug this shape exists to stop" (156-164). The confirmation copy at Settings.tsx:4794-4795 reads `destroy {w.dirty > 0 ? plural(w.dirty, 'uncommitted file') : 'it'}{w.ahead > 0 ? ` and ${plural(w.ahead, 'unpushed commit')}` : ''}?` and its button calls `remove(w, true)` (4797).
```

**Failure.** An orphaned worktree on a network mount where `git status --porcelain=v1 -z` times out (30s, worktrees.ts:166) has `dirty.count === null` and 3 unpushed commits. The row prints "none" under Uncommitted. `risky` is true (ahead>0), so the confirm appears and reads "destroy it and 3 unpushed commits?" — no mention of uncommitted files. The user clicks "yes, delete", which calls `remove(w, true)`; force bypasses removeWorktree's `dirty.count === null && !force` refusal (worktrees.ts:670) and `git worktree remove --force` deletes edits that exist nowhere else. With ahead===0 the row still prints "none" for both columns and the remove button skips the confirmation entirely (4802).

**Fix.** Carry the unknown across IPC — make WorktreeInfo's `dirty`/`ahead` `number | null` (or add `dirtySaid`/`aheadSaid`) — and render null as "unreadable", not "none". Treat null as risky in `risky`, and name it in the confirm text ("git could not read this worktree's uncommitted files").

---

## src/renderer/src/views/Settings.tsx:5121 — [high] false-success  (CONFIRMED, sustained 3/3)

**Claim.** The Event retention Save button reports success unconditionally, because `setPref` swallows its own rejection and resolves — so a value main rejects is announced as saved.

**Evidence.**

```
5118: `const n = Math.max(1, Math.round(Number(days) || 0));`
5120: `await setPref('event_retention_days', String(n));`
5121: `setSaved({ tone: 'ok', text: \`Hook events are kept for ${plural(n, 'day')}.\` });`
`setPref` never rethrows (line 699-709): `catch (e) { setPrefsErr(\`“${k}” was not saved: ${msg(e)} — the value on screen is the one you typed, not the one on disk.\`); }`
Main rejects the value at `src/main/settings.ts:169-173`: `if (!/^[1-9]\d{0,3}$/.test(preferenceValue)) throw new Error('Event retention must be a whole number of days.');` and `if (days > 3650) throw new Error('Event retention cannot exceed 3650 days.');`
```

**Failure.** Type `5000` into the Event retention field (the `max={3650}` on line 5112 is not enforced — the input is not inside a form and the button is a plain button) and click Save. Main throws “Event retention cannot exceed 3650 days.”, nothing is written, retention stays at 30 — and a green `<Note tone="ok">Hook events are kept for 5,000 days.</Note>` renders immediately under the control. The real error lands in `prefsErr`, rendered at line 754 at the very top of the page, outside the scrolled tab panel and far above the Storage section at the bottom of Privacy & data.

**Fix.** Have `setPref` return a success boolean (or rethrow and let callers catch), and gate line 5121 on it: `if (await setPref(...)) setSaved({tone:'ok', …}); else setSaved({tone:'error', …});`

---

## src/renderer/src/views/Settings.tsx:451 — [medium] state-crosstalk  (CONFIRMED, sustained 3/3)

**Claim.** One `msgState` is written by both the Claude Platform API key panel and the Automation spend-cap panel and rendered in both, so each panel prints the other's result.

**Evidence.**

```
Settings.tsx:451 `const [msgState, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);` — rendered at Settings.tsx:875 (inside `<Section title="Claude Platform API key">`) and again at Settings.tsx:1040 (inside `<Section title="Spending">`), and written by the spend-cap Save at Settings.tsx:1028 `setMsg({ tone: 'ok', text: v > 0 ? \`Runs estimated above $${v.toFixed(2)} will be blocked.\` : 'Spend cap disabled.' });`
```

**Failure.** Every tab panel is mounted at once — `SettingsTabPanel` renders `<div … hidden={!active}>` (Settings.tsx:405-406) — so both Notes are live. Open Settings → Automation → set the cap to 5 → Save. Switch to the Agents tab: under "Claude Platform API key" a green Note reads "Runs estimated above $5.00 will be blocked." It runs the other way too: the key-status read failure at Settings.tsx:514-517 ("Wanigan could not read whether a key is installed … What this panel shows below is not an answer about your key.") renders under Spending, where it reads as a statement about the spend cap.

**Fix.** Give the spend-cap panel its own state (`const [capMsg, setCapMsg] = useState(...)`) and render it at line 1040, leaving `msgState` to the key panel.

---

## src/renderer/src/views/Settings.tsx:514 — [medium] shared-state  (CONFIRMED, sustained 3/3)

**Claim.** The key panel's message slot is the root component's `msgState`, which the Spending section also renders, so the key-status read failure written at :514 is displayed under the spend-cap field as that section's own message.

**Evidence.**

```
Settings.tsx:514-517 `void load().catch((e) => setMsg({ tone: 'error', text: \`Wanigan could not read whether a key is installed: ${msg(e)}. What this panel shows below is not an answer about your key.\` }));`. That one state is rendered twice: :875 inside the Claude Platform API key Section and :1040 inside the Spending Section, `{msgState && <div style={{ marginTop: 11 }}><Note tone={msgState.tone === 'ok' ? 'ok' : 'error'}>{msgState.text}</Note></div>}`, immediately below the cap field and its own error handler at :1030. The three hardened panels each own a private slot instead (`glmMsg` :478, `deepseekMsg` :484, `xaiMsg` :490).
```

**Failure.** `key:status` fails on mount (the case the :514 catch exists for); the operator switches to Automation → Spending renders the red note "Wanigan could not read whether a key is installed: … What this panel shows below is not an answer about your key" directly beneath "Maximum estimated cost per run (USD)", where "this panel" is the spend cap and every word of the sentence is about a different setting. The same slot carries Verify/Save results from :623/:637 into Spending, and `setMsg(null)` at :619/:635 erases the cap's "the saved cap is unchanged" failure note.

**Fix.** Give the Claude key panel its own `keyMsg` state (as glm/deepseek/xai each have) and leave `msgState` to the Spending section, or vice versa; nothing should write a message that two unrelated Sections both render.

---

## src/renderer/src/views/Settings.tsx:641 — [medium] silent-destructive-action  (PLAUSIBLE, sustained 2/3)

**Claim.** Remove deletes the stored Claude Platform credential with no feedback and no state change whenever ANTHROPIC_API_KEY is also exported: `clear()` wipes the message area, and the reloaded status is identical because both `present` and `fingerprint` are satisfied by the env var.

**Evidence.**

```
Settings.tsx:641-644 `async function clear() { await window.wanigan.key.clear(); setMsg(null); await load(); onKeyChange(); }` — no busy flag and no catch, unlike clearGlm/clearDeepseek/clearXai (:560-564, :586-590, :612-616) which all wrap in `try { … } finally { setXBusy(false) }`. Main deletes only the file (index.ts:2145 `handle('key:clear', () => { clearKey(); return true; });`, keys.ts:107-109 `fs.unlinkSync(keyFile())`), while the status it reads back is env-satisfied: index.ts:2055-2056 `present: hasKey() || Boolean(process.env.ANTHROPIC_API_KEY)`, `fingerprint: keyFingerprint()` → keys.ts:64-67 `if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;`.
```

**Failure.** ANTHROPIC_API_KEY exported (the state keys.ts:99 tells operators to use when OS encryption is unavailable) plus a key stored in the Keychain. One click on Remove (no confirmation) irreversibly unlinks apikey.bin, then `setMsg(null)` clears the panel's only message slot and `load()` returns the same `present: true` and the same env-derived fingerprint — the panel is pixel-identical before and after. The operator concludes Remove did nothing, and discovers the stored key is gone only after unsetting the env var. Remove/Verify also stay enabled throughout, since `clear()` never sets `busy`.

**Fix.** Have `clear()` mirror `clearGlm()` — set/clear `busy` in a `finally`, catch and report — and report the outcome from the reloaded status: when `status.fromEnv` is true, say the stored key was removed and that ANTHROPIC_API_KEY is still supplying one, instead of re-rendering an unchanged "key installed".

**Dissent (the verifier who refuted).** Refuted. The panel's behaviour in exactly the state the finding describes is designed and disclosed, and nothing it renders after Remove is false.

1. The env case is explicitly surfaced in that panel, immediately above the pill the finding says is misleading. /Users/dane/Projects/drupal/wanigan/src/renderer/src/views/Settings.tsx:815-821: `{status?.fromEnv && ( … <Note tone="info"><code className="mono">ANTHROPIC_API_KEY</code> is set in the environment and takes precedence over anything stored here.</Note>`. `fromEnv` exists in the payload for no other purpose (src/main/index.ts:2058, src/preload/index.ts:211, and it is the only `fromEnv` consumer in the renderer). So whenever Remove's effect is invisible, the panel is already telling the operator that what is shown is not the stored credential.

2. The post-Remove status is truthful, not stale. `present: hasKey() || Boolean(process.env.ANTHROPIC_API_KEY)` (src/main/index.ts:2055) and `keyFingerprint()` → `getKey()` (src/main/keys.ts:64-67, "An explicit env var still wins, for CI and scripted runs") report the credential Batches will actually use. After the unlink, Wanigan genuinely still has a usable Platform key and the fingerprint shown is the one every request will carry. Reporting the effective credential rather than the stored one is this repo's stated doctrine for ambient Anthropic env vars: src/shared/types.ts:1617-1624 ("when one is exported the account picker would otherwise be showing a choice the session ignores"), Settings.tsx:3672-3674, src/main/egress.ts:451 ("Absent if you use ANTHROPIC_API_KEY instead"). A finding needs a wrong render; this render is correct.

3. "No feedback" is the house pattern for all four key removals, not an omission unique to `clear()`. clearGlm/clearDeepseek/clearXai also end in `setGlmMsg(null)` / `setDeepseekMsg(null)` / `setXaiMsg(null)` (Settings.tsx:562, 588, 614) — none emits a success note; the status flip is the feedback. Likewise none of the four Remove buttons (833, 920, 949, 975) uses the confirmation Callout this file uses for recorded data (1437, 1554, 4643, 5064), a consistent distinction between a re-pastable credential and evidence.

4. The busy/catch asymmetry produces no concrete failure. `key:clear` cannot reject: `handle('key:clear', () => { clearKey(); return true; })` (src/main/index.ts:2145) over `try { fs.unlinkSync(keyFile()); } catch { /* already gone */ }` (src/main/keys.ts:107-109), so a second click on the still-enabled button unlinks an already-gone file as a no-op, and a Verify in the gap reports the env key accurately.

5. "Pixel-identical" is also not strictly true: the workspace pill (Settings.tsx:828-831) is fed by `getWorkspaceId()` = `process.env.ANTHROPIC_WORKSPACE_ID || readCreds()?.workspaceId` (src/main/keys.ts:76-78), so a stored workspace id disappears from the panel on Remove.

What remains is that the operator must read the precedence Note to infer the click landed, and that the deleted key was already inert (every call resolved to the env var). That is a usability nit about a removal the operator deliberately requested via a red danger button — no wrong output, no wrong money, no crash. Note one unrelated, smaller thing I did verify while checking: the comment at Settings.tsx:512-513 claims "the two callers that `await` it report the failure through this same Note", and `clear()` (641-644) is one of those two callers but has no try/catch, so a rejecting `load()` there would be unhandled. I found no throwing path in `key:status` to make that concrete, and it is not the reported finding.

---

## src/renderer/src/views/Settings.tsx:1100 — [medium] false-claim  (CONFIRMED, sustained 3/3)

**Claim.** `needs-trust` is the single status for "manifest untrusted OR adapter untrusted", but the renderer's sentence for it asserts a manifest-specific fact, so a pack whose manifest digest IS trusted is told on screen that it is not — and routed back to the manifest grant instead of the adapter grant that actually blocks enabling.

**Evidence.**

```
Settings.tsx:1100: `'needs-trust': { glyph: '?', word: 'needs trust', ..., effect: 'this exact manifest digest has not been trusted yet' }`, rendered unconditionally at Settings.tsx:1281 `<p className="faint set-pack-blurb">{mark.effect}.</p>`. The status it keys off conflates both grants — src/main/provider-packs.ts:1486-1487: `: !manifestTrusted || !adapterTrusted ? 'needs-trust'`. Nothing else on the card carries manifest trust state: the `Manifest digest` row prints only the digest (Settings.tsx:1299-1305), and `trustedManifestSha256` is never read anywhere in src/renderer (grep returns zero hits), unlike the `Adapter` row which does say 'this exact digest is trusted' (Settings.tsx:1290-1292).
```

**Failure.** Local pack with an adapter, manifest digest trusted, adapter digest not (the state smoke4.ts:1916-1926 exercises in reverse, and the exact state finding 1 leaves behind). `manifestTrusted === true`, `adapterTrusted === false`, so status is `needs-trust` and the card prints "needs trust — this exact manifest digest has not been trusted yet." — false, the digest in `.provider-packs-state.json` matches `manifestSha256`. The action row's `needs-trust` branch (Settings.tsx:1397-1401) then offers only `Read the manifest…`, sending the operator to re-grant what is already granted, while the blocker is reachable only via the secondary `Read the adapter…` button and stated only in the `Adapter` row.

**Fix.** Derive the sentence from the two digest pairs the payload already carries (`manifestSha256 === trustedManifestSha256`, `adapterSha256 === trustedAdapterSha256`) rather than from the conflated status, naming which of the two grants is missing, and show trust state on the `Manifest digest` row the way the `Adapter` row already does.

---

## src/renderer/src/views/Settings.tsx:1745 — [medium] honest-state  (CONFIRMED, sustained 3/3)

**Claim.** A failed `git for-each-ref` is collapsed to an empty ref list, which the panel then reports as the positive finding "there is nothing to remove".

**Evidence.**

```
checkpoints.ts:498-499 — `const fer = await runGit(root, ['for-each-ref', '--format=%(refname)', 'refs/wanigan/'], { timeout: 15_000 }); const refs = fer.ok ? fer.out.split('\n').filter(Boolean) : [];` — `fer.err` is dropped and the failure is never returned. The dry run then returns `{ refs: refs.length, rows: uniqueIds.length, applied: false }` (checkpoints.ts:513). Settings.tsx:1743-1745 — `if (counted.refs === 0 && counted.rows === 0) { setCpCleanup(null); setSaved({ tone: 'ok', text: `No Wanigan checkpoints in “${p.name}” — there is nothing to remove.` }); }`. Note the surrounding function raises a real error for a non-repository (checkpoints.ts:495), so the caller is entitled to read a returned zero as observed.
```

**Failure.** On a large or network-mounted repository the 15s `for-each-ref` times out; `runGit` returns ok:false and `refs` becomes `[]`. If the `session_checkpoints` rows for it have already been pruned, `rows` is 0 too, and the panel reports in an ok tone "No Wanigan checkpoints in “monorepo” — there is nothing to remove." The hidden refs and their objects stay on disk indefinitely, and the one surface that exists to find them has told the user they do not exist.

**Fix.** Propagate the failure instead of substituting an empty list: `if (!fer.ok) throw new Error(...)` (matching the existing throw at 495), or return the git message so Settings can render "could not read this repository's snapshot refs" rather than a zero.

---

## src/renderer/src/views/Settings.tsx:1759 — [medium] honest-state  (CONFIRMED, sustained 3/3)

**Claim.** "Removed N snapshot refs" is printed from the count that was found, not the count that was deleted; every `update-ref -d` result is discarded.

**Evidence.**

```
Settings.tsx:1757-1759 — `const done = await window.wanigan.checkpoints.removeRepo(p.path, true); … setSaved({ tone: 'ok', text: `Removed ${done.refs} snapshot ref${done.refs === 1 ? '' : 's'} from “${p.name}”. …` })`. In checkpoints.ts:515-521 the apply loop is `for (const ref of refs) { await runGit(root, ['update-ref', '-d', ref], { timeout: 8_000 }); }` — the GitRun is never inspected — and the function then returns `{ refs: refs.length, rows: uniqueIds.length, applied: true }`, i.e. the same `refs.length` it counted at line 499. runGit returns `{ok:false}` rather than throwing on failure (git.ts:135-140).
```

**Failure.** A repository with 40 `refs/wanigan/*` refs where another git process holds `.git/refs` locked, or where the 8s timeout is exceeded: every `update-ref -d` returns ok:false, nothing is deleted, and the panel reports "Removed 40 snapshot refs from “api”. Live sessions keep theirs; git reclaims the objects on its own schedule." The user believes the repository is clean; the refs and their objects are still there, and the DB rows for them were separately deleted at 518-520, so the next count can no longer find them by row.

**Fix.** Count only the deletions that reported ok — `let removed = 0; for (const ref of refs) { const r = await runGit(…); if (r.ok) removed++; }` — return that as `refs`, and return the failures so the panel can say how many were refused.

---

## src/renderer/src/views/Settings.tsx:1834 — [medium] false-success  (CONFIRMED, sustained 3/3)

**Claim.** Project removal announces success without awaiting the removal, and the promise it discards has no rejection handler — so a failed delete leaves the project on screen next to a green note saying it was removed.

**Evidence.**

```
1830-1834:
```
onConfirm={() => {
  const name = target.name;
  setConfirming(null);
  onRemoveProject(target.id);
  setSaved({ tone: 'ok', text: `“${name}” and its recorded work were removed. The repository on disk was not touched.` });
}}
```
`onRemoveProject` is declared `(id: string) => void` (line 437), but App supplies an async function that can reject: `src/renderer/src/App.tsx:775` — `const removeProject = useCallback(async (id: string) => { const list = await window.wanigan.projects.remove(id); setProjectsRead(true); setProjects(list); }, []);` with no catch. Main's handler is a bare synchronous DELETE: `src/main/index.ts:1934` — `handle('projects:remove', (id: string) => { removeProject(id); return listProjects(); });` over `src/main/store.ts:106` — `db().prepare('DELETE FROM projects WHERE id = ?').run(id);`
```

**Failure.** Confirm removal while the SQLite write fails (SQLITE_BUSY from a concurrent writer, a read-only or full volume, or the documented post-restore window in which “its other panels will fail until the app comes back”). `projects.remove` rejects, `setProjects` in App never runs so the project row is still listed, and the rejection is unhandled — the declared `void` return means `no-floating-promises` does not flag the call site. The operator sees the project still in the list with “‘Northstar Storefront’ and its recorded work were removed.” under it, and no error anywhere.

**Fix.** Make the prop `(id: string) => Promise<void>` and await it: `try { await onRemoveProject(target.id); setSaved({tone:'ok', …}); } catch (e) { setSaved({tone:'error', text: msg(e)}); }`.

---

## src/renderer/src/views/Settings.tsx:1967 — [medium] honest-state  (PLAUSIBLE, sustained 2/3)

**Claim.** When `prefs.all()` fails, two panels state an unread preference as a measured "off", and the error banner titles a failed read as a failed save.

**Evidence.**

```
Settings.tsx:1967 — `<Mark {...(prefs?.hooks ? { glyph: '✓', word: 'enabled', color: 'var(--good)' } : OFF)} />`, and 4966-4968 — `{prefs?.archiveTranscripts ? 'Archiving is on…' : 'Archiving is off in Observation above, so none will be written.'}`. `prefs` starts null and the only read is `loadPrefs` at 652-655, whose catch is `.catch((e) => setPrefsErr(msg(e)))` — it never retries and never sets prefs. The banner that surfaces it is Settings.tsx:754 — `{prefsErr && <Callout level="critical" title="A preference did not save.">{prefsErr}</Callout>}`. The OTLP row two lines above (1955-1958) distinguishes the three states correctly via `prefs && !prefs.telemetry`, and TranscriptSearch:5280-5284 renders `'that switch is still loading.'` for the same null — so the pattern is applied elsewhere and missed here.
```

**Failure.** After `backup.restore()` the app's database connection is closed and the page itself warns "its other panels will fail until the app comes back" (Settings.tsx:5633-5635). `prefs.all()` rejects, `prefs` stays null. The Listeners table then prints "Hook bus — ○ off" as an observed listener status, Storage prints "Archiving is off in Observation above, so none will be written", and the banner above both says "A preference did not save." — three statements about settings Wanigan never managed to read, one of which announces a save that was never attempted.

**Fix.** Render `prefs === null` as a third state in both places ("unread" / "still loading"), as the OTLP row and TranscriptSearch already do, and split `prefsErr` into a read error and a save error so the banner title matches what failed.

**Dissent (the verifier who refuted).** The stated failure does not follow. (1) Post-restore is unreachable as described: `prefs` is state on the Settings component (Settings.tsx:648), set only on a successful read (654) or successful save (702) and never reset to null; the restore button and its warning callout (5589-5592) live inside that same mounted component, so when the db closes `prefs` already holds the values read at mount. No banner, no OFF row, no Storage sentence. (2) Forcing a remount (App.tsx:1424 renders Settings under `tab === 'settings' &&`, so navigating away destroys it) kills the second panel rather than producing the claim: the 4966-4968 sentence sits inside `<Frame v={store.v}>` whose loader is `transcripts.list()` + `uploads.list()` (Settings.tsx:4894-4900), and `archivedSessions()` is `db().prepare('SELECT … FROM transcripts …')` (src/main/transcripts.ts:695) — with the connection closed (`live.close()`, src/main/backup.ts:636; `_db` is never cleared, src/main/db.ts:41-42) that Frame renders its error branch, so "Archiving is off in Observation above" cannot render in any state where prefs.all() persistently fails; only in a sub-frame mount race. (3) The Listeners Frame does survive a dead db (usage:collector → otel.collectorPort(), index.ts:2159 / otel.ts:156; mcp:server → mcpServerInfo(), mcp/capabilities.ts:40 — both in-memory), so line 1967 does print "○ off" when prefs is null. But every reachable persistent rejection of settings:all (allSettings → getSetting → db()) is a dead-database state — recovery mode (index.ts:766-788, which keeps the full UI up behind a banner) or post-restore — and in both `stopServices()` has already torn down the hook listener, so a "Listener / Status" cell reading off is not a false statement about the world. Making that row lie needs a prefs read failing while services run (e.g. SQLITE_BUSY past the 10s timeout, db.ts:61), which the finding neither identifies nor demonstrates. What survives is far narrower than reported: in recovery mode the Callout title at Settings.tsx:754 does mis-title a failed read as "A preference did not save." (the save path supplies its own "…was not saved:" text at 707). That is a one-banner wording defect, not two panels asserting an unread preference as a measured off.

---

## src/renderer/src/views/Settings.tsx:2603 — [medium] missing-control  (CONFIRMED, sustained 3/3)

**Claim.** The Phone monitor callout tells the operator that Repository review is something they enable and describes exactly what it grants, but no control for `mobile_repository_review` exists anywhere in the renderer — the setting is wired end to end in main and is unreachable from the app.

**Evidence.**

```
2598: `<Callout title="The dashboard reads only, until you enable iPad control or Repository review.">`
2603-2605: “With Repository review enabled, a paired browser can also read which files each project has changed, read one file's diff, run that project's saved review gate, and commit what git already tracks…”
`grep -rn "mobile_repository_review\|mobileRepositoryReview" src/renderer/` returns only those two prose lines — no `Toggle`, no `setFlag`, no read of `prefs.mobileRepositoryReview`.
Main has the whole setting: `src/main/settings.ts:81` — `return bool('mobile_repository_review', false);`; `settings.ts:150` accepts it in `setUserPreference`; `settings.ts:256` exposes it as `mobileRepositoryReview` on `WaniganSettings`; and `src/main/mobile/git.ts:186` gates five routes on it — `return mobileConfig().dashboardEnabled && mobileRepositoryReview();`
```

**Failure.** An operator reads that callout in Connections › Phone monitor and goes looking for the Repository review switch. There is none in that section, in the Privacy & data tab, or anywhere else in Settings — and `SETTINGS_INDEX` (lines 52-78) has no entry for it, so ⌘K and the in-page search return nothing. The capability can never be turned on from the app (it defaults to `false`), and its state can never be read back or audited on the surface whose job is saying what leaves this machine. The page documents a grant it does not offer.

**Fix.** Add a `<Toggle title="Allow Repository review" on={prefs.mobileRepositoryReview} busy={pending === 'mobile_repository_review'} onChange={(v) => void setFlag('mobile_repository_review', v)}>` beside the “Allow paired iPad control” toggle (line 2622), pass `prefs`/`pending`/`setFlag` into `PhoneMonitor`, and add a matching `SETTINGS_INDEX` entry so the section is findable.

---

## src/renderer/src/views/Settings.tsx:4430 — [medium] unhandled-rejection  (CONFIRMED, sustained 3/3)

**Claim.** The MCP server "copy URL" button discards the clipboard promise and reports success unconditionally, so a refused write is reported as a copy that happened.

**Evidence.**

```
Settings.tsx:4430 `onClick={() => { void navigator.clipboard.writeText(info.url); setSaved({ tone: 'ok', text: 'URL copied. The bearer token is separate and is not shown here.' }); }}` — the same file does it correctly 2000 lines earlier (Settings.tsx:2384-2389 `await navigator.clipboard.writeText(value); … catch (e) { setResult({ tone: 'error', text: `The clipboard refused the write: ${msg(e)}` }); }`), and main/index.ts:1538-1541 carries the gravestone for this exact bug: "Discarded, a refused write left the renderer told it had copied."
```

**Failure.** `navigator.clipboard.writeText` rejects with NotAllowedError/"Document is not focused" (window focus lost between the click landing and the async write, or clipboard-write denied). The page prints the green note "URL copied.", the clipboard still holds its previous contents, and the operator pastes the wrong string into their MCP client config — the loopback URL and its port change every launch, so there is nothing on screen to catch the mistake against. The rejection also surfaces as an unhandled promise rejection.

**Fix.** Make the handler async and await the write, reporting failure the way PhoneMonitor's `copy()` at Settings.tsx:2383-2390 already does.

---

## src/renderer/src/views/Settings.tsx:4863 — [medium] focus-loss  (CONFIRMED, sustained 3/3)

**Claim.** Arrow-key navigation of the Motion radiogroup drops keyboard focus to `<body>`, because picking a value disables the enclosing fieldset before the deferred `.focus()` runs, and focus is never restored when the write completes.

**Evidence.**

```
4863: `<fieldset disabled={pending === 'motion'} className="set-motion-options">`
4872: `onPick={(v) => void setPref('motion', v)}` — and `setPref` opens with `setPending(k)` (line 700), flushed synchronously for a discrete key event.
`Options.move` defers the focus move past that commit (352-354):
```
requestAnimationFrame(() => {
  const choices = group?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  choices?.[next]?.focus({ preventScroll: true });
});
```
```

**Failure.** Tab to the Motion radiogroup and press ArrowRight. `onPick` fires, `pending` becomes `'motion'`, the fieldset disables all three `role="radio"` buttons, and the browser blurs the currently focused (now disabled) button — `document.activeElement` becomes `<body>`. The rAF callback then calls `.focus()` on a disabled element, which is a no-op. `pending` clears a few milliseconds later but nothing re-focuses, so the next ArrowRight does nothing and Tab restarts from the top of the document; a screen-reader user loses their place mid-selection. The Trust radiogroup at line 3271 uses the same `Options` component without a disabling fieldset and is unaffected.

**Fix.** Don't disable the group during the in-flight write — the `Options` buttons already reflect the picked value optimistically. Either drop `disabled={pending === 'motion'}` from the fieldset, or re-focus the chosen radio in an effect once `pending` returns to null.

---

## src/renderer/src/views/Settings.tsx:4902 — [medium] controlled-input-fights-user  (CONFIRMED, sustained 3/3)

**Claim.** The Event retention field re-seeds itself the instant it becomes empty, so it cannot be cleared — backspacing to empty refills it with the saved value and the next keystroke appends to that, producing a number the operator never intended.

**Evidence.**

```
4902: `useEffect(() => { if (prefs && days === '') setDays(String(prefs.eventRetentionDays)); }, [prefs, days]);`
The effect depends on `days` itself, so every transition to `''` re-triggers it. Corroboration that empty was expected to be reachable: the Save button guards on it at 5116 — `disabled={pending === 'event_retention_days' || !days.trim()}` — which is now unreachable dead code.
```

**Failure.** With retention saved at 90, select-all + Delete in the field to type a fresh value. `setDays('')` fires, the effect immediately runs and calls `setDays('90')`; React writes `'90'` back into the `<input type="number">`, which places the caret at the end. Typing `7` yields `907`. Save then writes 907 — it passes main's `/^[1-9]\d{0,3}$/` and the 3650 ceiling, so hook events are silently retained for 907 days instead of 7, and the operator is told “Hook events are kept for 907 days.”

**Fix.** Seed once instead of continuously — drop `days` from the dependency array and track seeding separately, e.g. `const seeded = useRef(false); useEffect(() => { if (prefs && !seeded.current) { seeded.current = true; setDays(String(prefs.eventRetentionDays)); } }, [prefs]);`

---

## src/renderer/src/views/Settings.tsx:4902 — [medium] correctness  (CONFIRMED, sustained 3/3)

**Claim.** The event-retention field re-fills itself the instant it becomes empty, so it cannot be cleared and its Save guard `!days.trim()` is dead.

**Evidence.**

```
Settings.tsx:4902 `useEffect(() => { if (prefs && days === '') setDays(String(prefs.eventRetentionDays)); }, [prefs, days]);` and Settings.tsx:5116 `<button className="btn" disabled={pending === 'event_retention_days' || !days.trim()}`
```

**Failure.** With retention saved at 30, `days` is '30'. The operator backspaces to empty: `onChange` (5114) sets `days` to '', the effect at 4902 fires on the `days` dependency and immediately calls `setDays('30')`, so the box shows 30 again with the caret repositioned — typing `7` then yields '307' or '730' rather than '7'. Because `days` can never remain '', the `!days.trim()` disjunct at 5116 never disables the button, so that guard is unreachable too.

**Fix.** Seed once instead of continuously: drop `days` from the dependency array and key the seed on the load, e.g. `useEffect(() => { if (prefs) setDays(String(prefs.eventRetentionDays)); }, [prefs])`, or track a `seeded` ref.

---

## src/renderer/src/views/Settings.tsx:5101 — [medium] heading-semantics  (CONFIRMED, sustained 3/3)

**Claim.** Settings' 20 group labels are <div>s, not headings, and the rows under them jump straight from h2 to h4, so heading navigation cannot reach the structure that organises the page visually.

**Evidence.**

```
src/renderer/src/views/Settings.tsx:5101-5104 — `<div className="set-sub">Event retention</div>` / `<div className="set-row" …>` / `<div className="txt">` / `<h4>How long hook events are kept</h4>`. The class is styled as a heading in src/renderer/src/styles/settings.css:196 — `.set-sub { margin: 16px 0 7px; font-size: 10.5px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); }`. There are 20 `className="set-sub"` labels in the file (1932, 2049, 2112, 2144, 2180, 2615, 2630, 2733, 2812, 3267, 3281, 3336, 3992, 4401, 4449, 4961, 5028, 5079, 5101, 5474) and the only <h3> in the view is Settings.tsx:4840 `<h3>Set the atmosphere</h3>`; the 11 `<Toggle>` rows and the dispatcher/retention rows render `<h4>` (324, 3948, 5104).
```

**Failure.** Open Settings → Privacy & data and navigate by heading (VoiceOver rotor, or H / 1-6 in NVDA). The outline is h1 "Settings" → h2 "Privacy & data" → h2 "Observation" → h4 "Record hook events" … → h2 "Storage" → h4 "How long hook events are kept", with no h3 at any point. The four group labels inside Storage — "Transcripts" (4961), "Uploaded batch files" (5028), "Session attachment directories" (5079), "Event retention" (5101) — are never announced, so a screen-reader user skimming by heading lands on the h4 with no indication which group's Forget/Delete controls precede it, and cannot jump between the three deletion scopes at all. Sighted users get all four as bold uppercase subheads.

**Fix.** Render the label as a heading — `<h3 className="set-sub">` — in all 20 places (or via a small `SubHead` in bits.tsx), leaving the existing `<h4>` row titles one level below it so the outline reads h1 → h2 → h3 → h4.

---

## src/renderer/src/views/Settings.tsx:451 — [low] misattributed-message  (CONFIRMED, sustained 3/3)

**Claim.** One `msgState` is shared by the API-key panel and the Spending panel, which live in two different tabs that are both always mounted, so each panel prints the other's outcome as if it were its own.

**Evidence.**

```
Settings.tsx:451 `const [msgState, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);` is rendered twice — at :875 inside the "Claude Platform API key" Section (agents tab, opened at :794) and at :1040 inside the "Spending" Section (automation tab, opened at :999) — and SettingsTabPanel keeps every panel in the DOM (`hidden={!active}`, :406). The Backup section states the opposite rule for itself at :5375-5377: "Kept with the action that produced it: a refusal from the restore path must not surface under 'Back up now', where it would read as a failed backup."
```

**Failure.** Press "Verify" on an invalid key: `setMsg({tone:'error', text:'Key rejected (401)…'})` (:637). Switch to the Automation tab and that red note is rendered directly under the spend-cap field, reading as a failure to save the cap. In the other direction, saving a cap prints the green "Runs estimated above $5.00 will be blocked." under the API-key field on the Agents tab.

**Fix.** Split the state — a `keyMsg` for the key panel and a `capMsg` for Spending — or tag the message with the action that produced it and render it only where it belongs, as Backup's `note.kind` already does.

---

## src/renderer/src/views/Settings.tsx:623 — [low] wrong-tone  (CONFIRMED, sustained 3/3)

**Claim.** "Batches API NOT reachable" is rendered inside a green `tone="ok"` Note, so the one capability this key exists for being unavailable is presented as success.

**Evidence.**

```
Settings.tsx:623 `setMsg({ tone: 'ok', text: \`${r.detail}${r.batches ? ' · Batches API reachable.' : ' · Batches API NOT reachable for this workspace.'}\` });` and :637 `setMsg({ tone: r.ok ? 'ok' : 'error', text: r.detail + (r.ok && !r.batches ? ' · Batches API NOT reachable.' : '') });`, rendered at :875 where `tone === 'ok'` maps to `.note.tone-ok { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }` (ui.css:108). `ok: true, batches: false` is a real verifyKey result: keys.ts:199-201 catches the batches fetch into `batchDetail` and keys.ts:208-217 still returns `ok: true` whenever /v1/models succeeded. The Section's own hint at :814 says the key is "Needed for Batches — estimating, dry runs, and submitting."
```

**Failure.** Paste a valid Platform key while the second request fails (org without Batches access, a 404/permission response, or a transient network error after /v1/models succeeded): the panel shows a green success Note reading "Authenticated. Newest model: … Could not reach the Batches API: fetch failed · Batches API NOT reachable for this workspace." The operator reads green-and-Authenticated, goes to the batch builder, and the submit path is the next thing to fail.

**Fix.** Use `tone: 'warn'` (already supported by Note) whenever `ok && !batches` in both handlers, reserving `'ok'` for `ok && batches`.

---

## src/renderer/src/views/Settings.tsx:1238 — [low] false-claim  (CONFIRMED, sustained 3/3)

**Claim.** `profilesFor` states a manifest fact ("no profiles declared") from a list that deliberately excludes invalid packs, so an invalid pack's card denies declaring the very profiles the error callout beside it names.

**Evidence.**

```
Settings.tsx:1237-1238: `const mine = profiles.v.d.filter((profile) => profile.packId === packId); if (mine.length === 0) return <span className="faint">no profiles declared</span>;` — but the registry drops every profile of an invalid pack before the list is built, src/main/provider-packs.ts:1542: `if (!record.manifest || record.status === 'invalid' || record.status === 'removed') continue;`.
```

**Failure.** A local pack with three profiles declares `editorExtensions`, which is refused for local packs (provider-packs.ts:1446-1450), so `status` becomes `invalid`. The card renders `Profiles: no profiles declared` while the Callout directly below it (Settings.tsx:1313-1319) prints `orbit-pro: local packs cannot select an executable by editor-extension path.` — naming a declared profile the same card just said does not exist.

**Fix.** In the zero-row branch, distinguish the registry's refusal from an empty manifest: when `packState(pack) === 'invalid'` (or `removed`), say the declared profiles are withheld because the pack did not validate, rather than asserting the manifest declares none.

---
