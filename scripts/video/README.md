# The launch video

A pipeline that records the real app being used, then cuts the recording into
the launch video: 1920×1080 and 1080×1350 (for the LinkedIn feed), a poster
for each, and an `.srt` of the captions. It is not part of `npm test`.

```
record.mjs   drive the app at a person's pace and record it      -> .artifacts/video/takes/<take>/
edit.mjs     cut one or more takes into the video                 -> .artifacts/video/cuts/<cut>/
review.mjs   frames, contact sheets and an OCR privacy check      -> .artifacts/video/cuts/<cut>/review/
story.mjs    the chapters and every caption (edit, then re-cut; no re-recording)
lib/         capture, the human driver, page overlays, the test site, the timeline, overlays, privacy
```

## Before you start

- Node 22.23.2 on `PATH`, and `npm run build` (or pass `--app "release/mac-arm64/Wanigan 2.app"`).
- ffmpeg on `PATH` (`brew install ffmpeg`). It needs `libx264`, `overlay`,
  `xfade`; it does **not** need `drawtext` or `subtitles`, which Homebrew's
  build lacks: captions and cards are drawn by Chromium as PNGs.
- A display. The window records at 1440×810 CSS px at 2× (2880×1620) and is kept
  on top of other windows while it records; an occluded window stops painting.
- Run it from a normal terminal. If an agent runs it, the Bash sandbox must be
  off (Electron, the real CLIs and ffmpeg all need it), and the script strips
  the agent's own environment (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_EFFORT`,
  `ELECTRON_RUN_AS_NODE`, `VSCODE_*`) so the sessions it starts behave as they
  would from the Dock. Inherited, `CLAUDE_CODE_CHILD_SESSION` turns Claude
  Code's transcript saving off.

## Record

```sh
node scripts/video/record.mjs --demo --take demo-1     # the app's demo: stand-in agents, free
node scripts/video/record.mjs --real --take real-1     # real Claude Code and Codex: spends turns
```

Options: `--chapters a,b,c` to record only some; `--app <path.app>` for a
packaged build; `--keep` to keep the throwaway data and test site;
`--jev-pause` (real mode, below); `--encoder vt` to encode the master with
VideoToolbox instead of x264.

Every take uses its own data folder under `/tmp/wanigan-video/<take>/`
(`WANIGAN_VIDEO_WORK` moves it). It is not under a home folder on purpose:
Claude Code's banner, the New session dialog and a card's branch all show
paths, and those must not carry a user name. Wanigan's real data, Wanigan 1
and your projects are never opened.

**Demo mode** drives `--demo`: the sample projects, stand-in agents, the
stand-in Jev and the stand-in AI review. The stand-ins cannot submit a card or
stop on a real prompt, so chapters d and e use the demo's own seeded moments:
NS-6 asking permission, NS-7 already in Review. Use it to rehearse the cut; the
footage says DEMO at the top.

**Real mode** builds a small test site (`lib/shop.mjs`: a shop page, a cart,
a `node --test` suite, four days of history, a local bare `origin`) and works
it with the real CLIs, on each agent's default account:

- Claude Code on `sonnet`, effort low, gets the card made on camera ("Free
  shipping note in the cart"). The site's `.claude/settings.json` allows edits,
  reads and the `wanigan` command and leaves every other shell command to ask,
  so Claude Code stops for permission when it runs the tests. At low effort it
  often folds the edit and the test run into one shell command; that command is
  the prompt Needs you shows. A second prompt, if one comes, is answered the
  same way in its terminal, on camera at 6×. The settings also set
  `defaultMode: default`, so your own default (auto mode, say) cannot skip it.
- Codex, effort low, on its own branch, gets a card already in Ready.
- The AI review is the real `claude -p`. Expect a few cents to a dollar in all.
- Folder trust and Codex's update offer are answered off camera and cut from
  the edit. The script reads the screen after each arrow key and presses Enter
  only once "Yes" (trust) or "Skip" (update) is the selected line, so it can
  never choose "Update now", which would run `brew upgrade`. Before typing a
  prompt it checks the terminal shows no question: a prompt typed into Codex's
  trust question quits it on the "n".
- Codex works in the background. Its sandbox refuses the socket the `wanigan`
  command uses, so it asks approval for each `wanigan` call; those are answered
  Yes off camera. Once its card is in Review, the take stops it, as a person
  would. All of it is in `take.json`'s notes. (Stopping it also clears a
  Wanigan misreading: Codex 0.155's turn-complete notification carries its
  reply, and Wanigan shows a finished Codex as "Needs permission".)
- Only the default Claude Code and Codex accounts stay listed in the take's
  data, so no other account's name can appear in a picker. Nothing on disk
  changes; each CLI records the throwaway folder's trust in its own state.

**Jev** needs a TypeSafe key. The core takes `TYPESAFE_API_KEY` from the
environment or your login shell. Without one, real mode shows the board's
"Set up Jev" hint for chapter b, and the cut should take chapter b from a demo
take (below). With `--jev-pause`, a real take with no key stops in
Settings › Jev before recording starts, until a person pastes a key into the
window. Nobody, script included, reads `jev.key` or prints a key.

Waiting is recorded in real time and marked; the edit speeds it up. A take's
`take.json` holds its marks: chapters, captions, speed-ups, cuts, what to frame
in 4:5, and anything the privacy scan saw.

## Cut

```sh
node scripts/video/edit.mjs --take demo-1
node scripts/video/edit.mjs --take real-1 --from a=demo-1 --from b=demo-1 --name launch
```

`--from <chapter>=<take>` takes a chapter from another take: the real cut can
use the demo's Watch view for the problem (a) and the demo's Jev (b). Other
options: `--chapters`, `--poster-at <chapter>:<seconds>`, `--keep-work`.

The edit:

- keeps each chapter's footage, drops what a take marked cut, and plays waits
  at 6× (faster when a wait would still run past 9 s), with a speed badge;
- draws captions from `story.mjs` (the demo's own wording where a caption has
  one) in IBM Plex on Wanigan's dark tokens, clear of the 0.5 s crossfades
  between chapters, each for at least a second per 15 characters;
- 16:9 scales the whole window; 4:5 frames an 810×810 CSS px square that
  follows each `focus` mark (wide things keep their left edge) over a caption band;
- puts a title card first (the poster: a real frame beside the title), and
  the open-source card last;
- writes `wanigan-2-launch.srt` with the same timings, and `cut.json`.

It refuses to keep footage where the take's privacy scan saw something.
`--allow-privacy` exists for checking a cut, never for posting one.

## Review

```sh
node scripts/video/review.mjs --cut launch
```

`node scripts/video/review.mjs --take real-1 --at 76,80.5` pulls a take's own
frames at given seconds, to see what happened when.

For a cut: one frame a second and contact sheets for each shape, and an OCR pass (Apple
Vision, compiled from `ocr.swift` on first use) over every frame, looking for
email addresses, `/Users/...`, Claude plan names, and this machine's names and
account labels. It also averages Wanigan's spot in the sidebar on every
encoded 16:9 frame and flags any that is warm. It exits 1 and says when and
what kind, never the text. Then look at the sheets yourself, for what neither
check reads: the orb in Needs you, and whether each cut lands where its caption
says it does.

## Rules the pipeline keeps

- **Wanigan is never amber on camera.** The page hides any orb whose signal is
  attention the same frame, and keeps it hidden until his water's tint (which
  the orb exposes on its canvas) has cleared. Every frame, it also counts any
  amber orb still showing; the take marks it like a privacy hit and the edit
  refuses it. The rest of the UI's amber, such as Needs you, stays.
- **Nothing personal on screen.** Before paint, the page masks email
  addresses, home folders, Claude plan names, and this machine's names and
  account labels (gathered at run time, held in memory, never written down).
  A scan of the visible text every 1.5 s marks anything that slips past, and
  the edit refuses those moments. The test site commits as "Corner Shop
  <shop@example.com>", never as you.
- **Nothing leaves the machine** except the agents' own model calls. The test
  site's `origin` is a bare repository beside it; no push reaches GitHub and no
  pull request is opened.

## Re-recording the final cut once the git workbench lands

1. Merge, then `npm run build`.
2. Write the git chapter in `lib/chapters.mjs`, `chapterF`: today it shows the
   Changes view and toggles Split. After the Changes view, drive the workbench
   the way a person would: stage the shop's changes, write a commit message,
   commit, open the history graph, push to `origin` (the local bare repo). Mark
   `take.caption('f2')` where staging starts, `take.focus(...)` on what matters,
   and `take.speed(6)`/`take.speed(1)` around anything slow. The f2 caption is
   already in `story.mjs`.
3. Rehearse in the demo: `node scripts/video/record.mjs --demo --take demo-final`
   and cut it (`edit.mjs --take demo-final`). The demo's Northstar folder has
   uncommitted changes and a bare `origin` too.
4. Record for real: `node scripts/video/record.mjs --real --take real-final`
   (add `--jev-pause` if Jev should be real and there is no key in the environment).
5. Cut: `node scripts/video/edit.mjs --take real-final --name launch`. Add
   `--from b=demo-final` when the real take had no Jev key (the Jev chapter is
   then the demo's stand-in, and says DEMO at the top), and `--from a=demo-final`
   if the opening should be the demo's four agents at once rather than the
   real board.
6. Review: `node scripts/video/review.mjs --cut launch`, then watch both files
   through once, muted, on a phone.

The outputs are in `.artifacts/video/cuts/launch/`.

## When something goes wrong

- A take that fails still saves `master.mp4`, `take.json` and `failed.jpg`
  (the last frame) and ends every session it started.
- `record.log` in the take's folder has every mark as it happened.
- If a take is killed, end its leftovers with `pkill -f /tmp/wanigan-video/<take>`.
