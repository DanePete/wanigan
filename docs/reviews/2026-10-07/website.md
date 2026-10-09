# Wanigan website release update

## Source-install correction, published afterward

The live site's source instructions still cloned the default branch, which was behind the downloadable release. Fixed in `59d821e9d7cfb2d21eb399e72a1c55259f034ef8` on `codex-review-site` and deployed immediately through Cloudflare as version `9e4a8d32-cf4b-46c0-b3f6-157703bc87a5`.

- `content/site.ts:398`: the copyable clone command now uses `--branch v${download.version} --depth 1`.
- `content/site.ts:49`: source buttons follow `/tree/v${download.version}`. The build-from-source button names its exact version.
- `content/site.ts:50`: feature proof follows `/blob/v${download.version}/docs/features.md`, so the page's evidence matches the build.
- `lib/releases.test.ts:30`: “source installation and feature proof target the same release as the download” failed before the fix because no tag was selected; passed afterward. Full unit suite 19/19, typecheck, lint, build and diff checks passed.
- Both new GitHub source URLs returned HTTP 200.
- Live HTML again matches the built file byte for byte, SHA-256 `1bdbd7cfdbdc8c3f114f89f547da3b432c19e09629ecf7f4592728a009b87d3c`.
- Targeted live browser checks passed at 1440/390 in both themes, including the exact displayed clone command, source and feature-matrix hrefs, unchanged alpha.2 download/checksum, current/history states, no overflow and no page errors. Log: `check-live-source.log`; screenshots: `live-source-{1440,390}-{dark,light}.png`.
- The app's main branch was not changed at that publication step; the owner subsequently approved merging the reviewed commits into main. These links remain reproducible after main advances.

## Published

Published to **https://wanigan.ai** through `npm run deploy:cloudflare` after the GitHub alpha.2 DMG returned HTTP 200.

- Final metadata commit: `7230c82914926a4c5d02d43f0144fb0438b8a473`, on `codex-review-site`.
- Cloudflare deployment version: `f1fdc786-f00c-4e45-ad7e-bb5a52c022f8`.
- Download: `https://github.com/DanePete/wanigan-2/releases/download/v2.0.0-alpha.2/Wanigan-2-2.0.0-alpha.2-mac-arm64.dmg`.
- DMG SHA-256: `5d520be440751d805f6e78af23f308468efc835638fc6731c0218dbdf858c894`.
- Actual size: 161,157,680 bytes; site displays 161.2 MB. Minimum macOS 13, ad-hoc signed, not notarized.
- Dated history now marks alpha.2 Latest release and alpha.1 Earlier release; alpha.2 notes also mention the keyboard dialog fix.
- Final metadata: unit tests 18/18, typecheck, lint and build passed before deployment; built HTML version/checksum/current/previous states verified.
- Live HTML is byte-identical to `dist/client/index.html`, SHA-256 `91ff4fcacb29c9de612be68640c335a80b0c0dad1d8ab4a71093c8dfc9693cff`.
- Live same-origin CSP, no-transform and no-cookie headers verified. Public DMG HEAD is HTTP 200 with the exact expected 161,157,680-byte length.
- Live browser checks at 1440 and 390 pixels in both themes pass: download URL/checksum, correct current/history status, release notes URL, no overflow or page errors. Screenshots: `live-releases-{1440,390}-{dark,light}.png`. Log: `check-live-retry.log`. The first run’s fourth navigation timed out waiting for the section; a fresh complete four-context run passed, with response diagnostics armed and no recurrence. The timeout’s cause was not established.
- No website git remote exists, so both site commits are local. `.claude/` remains untouched and untracked. No redirect worker changes were needed.

## Preparation record (before publication)

Prepared in `~/Projects/drupal/wanigan/marketing`, branch `codex-review-site`.
Commit: `da97080` — Add dated release notes and prepare alpha 2 site update.

No deployment or website push performed. The download record remains v2.0.0-alpha.1, unchanged byte-for-byte. `.claude/` remains untracked and untouched. The two original scrollable-code accessibility changes in `components/Sections.tsx` were preserved and committed with narrow, explained lint exceptions.

## Ready

- Dated “What’s new & bug fixes” section after Try it, using the existing poster typography, colors and layout tokens.
- Four concise alpha.2 fix groups: git data protection, publishing checks, sessions/core replacement, Jev/settings/removed legacy import. Alpha.1 release history remains below it.
- Header, footer and download-note links. Mobile reaches the history through the download note and footer; the optional header link hides before it crowds the header.
- Status derives from one publication boundary, `download.version`. Newer entries are Preparing release with no nonexistent release link. The download version is Latest release; prior entries remain linked.
- Codex startup limitation copy updated to reflect the fixed composer readiness gate.
- README explains the publication workflow.

## Verification

Node 22.23.2 selected with nvm use.

- `npm run test:unit`: 18/18 pass, including release status changes, omitted-current-version refusal and dated/unique history checks. New release test initially failed before its implementation existed.
- `npm run typecheck`: pass.
- `npm run lint`: pass with one pre-existing warning, `video/worker.ts:16` anonymous default export. Normal lint initially failed discovering the untracked `.claude` worktrees' own configurations and rejecting the owner's keyboard focus additions. The command now excludes `.claude` before configuration discovery, and the two named scrollable code regions have local, explained rule exceptions.
- `WANIGAN_SOURCE=/private/tmp/wanigan-site-committed-engine npm run build`: pass. This intentionally unavailable source selects and cryptographically verifies the committed engine; no Wanigan 1 source or runtime data was read. Prerender requires localhost permission outside the sandbox.
- `env -u ELECTRON_RUN_AS_NODE WANIGAN_SOURCE=~/Projects/drupal/wanigan-2 npm run test:companion`: pass. Its separate Electron test uses a temporary profile, no Wanigan main process. 8,144 particles moved; rain/pause passed; zero GPU errors.
- `npm run check:site -- --label=ready --output=/private/tmp/wanigan-site-review/check-final`: pass. Full log: `check-final.log`. Both themes, 1440/390 layouts, keyboard release navigation, dates, pending/current notes links, same-origin requests, no cookies/console errors, images, heading/accessibility names, video lazy loading, reduced motion, WebGPU fallback, Mac/non-Mac download behavior. Added 320/560/768-width checks all show zero overflow.
- `git diff --check`: pass.

Narrow width bugs were observed before fixes: existing source-repository button made the 320px page overflow by 21px; the new header link made 560px overflow by 6px. The source button now wraps and the optional news link hides at narrow tablet widths. Both themes pass at both widths.

The page was 14,720px tall before the requested section and 15,266px after. The editorial height limit was deliberately adjusted from 15,000 to 15,600, with the new section's ~550px cost explained in the check. This does not suppress the independent overflow/layout checks. Activating alpha.2 adds its release notes link and should remain below the guard.

## Screenshots reviewed

Before, both themes and widths: `before-get-1440-dark.png`, `before-get-1440-light.png`, `before-get-390-dark.png`, `before-get-390-light.png`.
After, both themes and widths: `check-final/releases-desktop-dark.png`, `check-final/releases-desktop-light.png`, `check-final/releases-phone-dark.png`, `check-final/releases-phone-light.png`.
Updated download screenshots: `check-final/get-ready-dark.png`, `check-final/get-ready-light.png`, `check-final/get-ready-not-mac.png`.

## Final publication handoff

Once the actual GitHub v2.0.0-alpha.2 release is available, update the seven fields of `download` in `content/site.ts` together (url, version, sizeMB, sha256, minMacOS, notarized, releaseNotes), with measured asset size and checksum. Keep notarized false unless the actual package says otherwise. The release ledger, hero, comparison table and structured data all take their current version from that record.

Rebuild using the committed verified engine or an explicitly selected Wanigan 2 source. Restart the local Wrangler preview after rebuilding: its asset index can retain a 404 after dist is replaced. Run final checks/screenshot review with the actual release record. Deploy only with the authorized Cloudflare path `npm run deploy:cloudflare` and `cloudflare-static.jsonc`; do not use the stale Sites hosting metadata. Check deployed HTML bytes against `dist/client/index.html`, served asset/hash/version links, headers and live-page behavior. The separate redirect worker does not need a change.
