# Alpha.3 website publication

[wanigan.ai](https://wanigan.ai) now offers [Wanigan 2.0.0-alpha.3](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.3). Publication followed the owner's authorization and confirmation that the release was public and the app checks had passed. The preceding alpha.2 website record remains historical in [website.md](website.md).

- Website commit: `61bf38f8dfce509a590d8d272d9ed1d59e3c3f5f`, branch `codex-review-site`. Only `content/site.ts` changed: download metadata and the dated alpha.3 release entry. Alpha.2 and alpha.1 stay in the history.
- Cloudflare deployment: `fe000fd7-a1b6-43af-88c1-6ad2ddfdeda9`, through `npm run deploy:cloudflare` using the existing Workers Static Assets configuration. No redirect-worker change.
- Download: [alpha.3 DMG](https://github.com/DanePete/wanigan-2/releases/download/v2.0.0-alpha.3/Wanigan-2-2.0.0-alpha.3-mac-arm64.dmg), **159,735,704 bytes**, displayed as 159.7 MB.
- DMG SHA-256: `50f8097e5fefe4e831fbac17af5d3544534aad970b0df23cf04db0f2cf762ef4`. Metadata came from the independently verified release artifact; this website check verified its public HEAD response and exact size.
- Minimum macOS 13 and `notarized: false` remain unchanged. Source instructions, source buttons and the feature-matrix link select `v2.0.0-alpha.3`.

The notes identify the alpha.2 staging-refresh error and the Git 2.55 fixture maintenance race, distinguishing the test correction from app behavior. They make no new claim of model-provider verification.

## Checks and results

Node 22.23.2 was selected with `nvm use`.

| Check | Result |
|---|---|
| `npm run test:unit` | 19 passed, zero failures |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed; unchanged `video/worker.ts:16` anonymous-default-export warning |
| `env -u ELECTRON_RUN_AS_NODE WANIGAN_SOURCE=/private/tmp/wanigan-site-committed-engine npm run build` | Passed; verified committed companion engine used, no engine changes |
| Local `npm run check:site -- --label=ready` | All checks passed |
| `git diff --check` | Passed before commit |
| Public release, source tag and feature-matrix URLs | HTTP 200; release independently confirmed non-draft |
| Public DMG HEAD | HTTP 200; Content-Length 159735704 |
| Live HTML compared with `dist/client/index.html` | Byte-for-byte equal |
| Live `npm run check:site -- --url=https://wanigan.ai --label=ready` | All checks passed, no retry required |
| Live exact metadata/source verifier | Passed at 1440px and 390px in dark and light |

The live HTML SHA-256 is `182894629522b7392232040855b8acea7d0d57da3e7baea7a3e9a96fc6799d96`.

Browser checks cover current/history labels, matching release links, the exact download and checksum, copied source command, source and feature-matrix links, keyboard navigation, image and control names, same-origin requests, headers, cookies, page errors, reduced motion, media fallbacks and download presentation. Additional widths 320/560/768px have zero horizontal overflow in both themes. Desktop height is 15,554px under the unchanged 15,600px guard. These are bounded checks, not comprehensive accessibility certification.

## Selected live screenshots

Visually reviewed after publication:

- Release history: [desktop dark](screenshots/website-alpha3/releases-desktop-dark.png), [desktop light](screenshots/website-alpha3/releases-desktop-light.png), [phone dark](screenshots/website-alpha3/releases-phone-dark.png), [phone light](screenshots/website-alpha3/releases-phone-light.png).
- Download and source instructions: [dark](screenshots/website-alpha3/get-ready-dark.png), [light](screenshots/website-alpha3/get-ready-light.png).

Expanded evidence is under `/private/tmp/wanigan-site-review`: `alpha3-final-{units,typecheck,lint,build,check}.log`, `alpha3-deploy.log`, `alpha3-live-check.log`, `alpha3-live-targeted.log`, and `alpha3-live.html`. The site has no git remote configured; the website commit is local and its build is deployed. `.claude` remains untracked and untouched. No app source, app build or user application data was touched during this website update.
