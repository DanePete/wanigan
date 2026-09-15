# Worktree bootstrap

`git worktree add` checks out tracked files and nothing else. An agent that
lands in a new worktree used to find its dependency folders symlinked back to
the main checkout, so its first `npm install` rewrote the main checkout's
`node_modules`; no local key or env file beyond a fixed list; no way to keep its
dev server off the next agent's port; and no hook for the project's own setup.
A new worktree is now given four things, and each is recorded and shown.

**Dependency folders** — link, clone or skip, chosen per project and stored in
Wanigan's database. Link stays the default because it was the only behaviour.
Clone is `/bin/cp -c -R` as an argv spawn with a five-minute limit, and only
where the source and the worktree share an APFS volume: `cp -c` exits 0 after
silently making a full copy anywhere else. A clone that cannot be made falls
back to a link, and the reason is kept on the result, because a link is the
sharing the operator chose to avoid. The launch dialog offers the choice under
"Isolate in a worktree" and stores a change only when the session starts.

**`.worktreeinclude`** — Claude Code's convention. Every untracked file that
matches a pattern *and* is gitignored is copied, each one a clone where the
volume allows (`COPYFILE_FICLONE`), never over an existing file, never through
a symlink and never through a link that leaves the worktree. git does both
halves of the matching (`ls-files --others --ignored --exclude-from`, then
`check-ignore --stdin -z`), so negation, anchoring and `**` mean what they mean
to git. It stops at 5,000 files or 1 GB and says where it stopped.

**A port block** — `worktreePortBlock(path)` hands out ten ports in
42000–48999 from a hash of the canonical path, passing over a block while any of
its ports answers on loopback or another live worktree holds it. The block is
recorded at creation so setup, the launch and teardown see the same ten. An
attended or headless agent launched in the worktree is given `WANIGAN_PORT`,
`WANIGAN_PORT_COUNT` and `WANIGAN_WORKTREE` after any provider pack's values,
and an agent outside a worktree inherits none of them. Ports are a convention
the agent may use; Wanigan binds and enforces nothing.

**Setup and teardown commands** — stored in Wanigan's database, never in the
repository, and saved through the same native consent dialog as review recipes
for any line not already stored. Setup runs through `$SHELL -lc` in the new
worktree before the agent starts, with a ten-minute allowance for the whole
list; teardown runs just before a worktree is removed, and only once removal is
going ahead, so a worktree kept for its uncommitted files is never torn down
underneath them. Both get `WANIGAN_WORKTREE`, `WANIGAN_REPO_ROOT`,
`WANIGAN_PORT` and `WANIGAN_PORT_COUNT`; exit codes, durations and bounded
output are recorded. **A failing setup keeps the worktree and does not stop the
launch**, and the branch row says exactly that.

Where it shows: **Changes › Worktree setup**, beside the review gate, holds the
dependency choice, the include file's state, both command lists and the recent
runs with each command's output. Under each agent worktree's row in
**Changes › Branches** is its setup verdict, ports, dependency outcome and
include copies. A read that failed is shown as failed, never as an empty list.

Two defects found on the way. The include copy the change started with ran
`git check-ignore -z` without `--stdin`, which git refuses outright, and with
`--literal-pathspecs`, which `check-ignore` also refuses — so it would have
copied nothing and reported git as the reason. And a setup line that started a
background process holding its output (`npm run dev &`) would have held the
launch for the full ten minutes; a command is now finished when its shell exits.

**A linked folder no longer reads as untracked work.** A `node_modules/` rule
matches directories only, and git does not treat a symlink as one. So every
linked worktree listed `?? node_modules`: merge and removal counted the link as
uncommitted work, and `git add -A` in the worktree committed a symlink to the
operator's checkout. Each linked path now gets one anchored line, such as
`/node_modules`, in the repository's local exclude file. That file is
`info/exclude` in the common git directory, which every worktree reads and
nothing commits. The line sits under a comment naming Wanigan and is written
once. It changes nothing in the main checkout, because a folder is only linked
when git already ignores it there. The Link caption says so before the choice is
made.

## Screenshots

| | Dark | Light |
|---|---|---|
| Before · Changes | ![](before/changes-dark.png) | ![](before/changes-light.png) |
| Before · Branches | ![](before/branches-dark.png) | ![](before/branches-light.png) |
| Before · Launch, isolated | ![](before/launch-dark.png) | ![](before/launch-light.png) |
| After · Worktree setup | ![](after/setup-panel-dark.png) | ![](after/setup-panel-light.png) |
| Before · Link's caption | ![](before/setup-link-dark.png) | ![](before/setup-link-light.png) |
| After · Link's caption | ![](after/setup-link-dark.png) | ![](after/setup-link-light.png) |
| After · Branches | ![](after/branches-dark.png) | ![](after/branches-light.png) |
| After · Launch, isolated | ![](after/launch-dark.png) | ![](after/launch-light.png) |
| After · settings unreadable | ![](after/setup-unreadable-dark.png) | ![](after/setup-unreadable-light.png) |

Rendered by `scripts/probe-worktree-bootstrap.mjs` in isolated Electron with
synthetic services; before from `dba7528` (`feat/advanced-gaps`) in a detached
worktree, except Link's caption, which is from `4c7151e`, the commit before the
exclude line. After is from this change, with the same fixtures. `verification.json` in each
directory lists the checks that ran. The main-process behaviour is checked
against real repositories in `src/main/smoke16.ts`.
