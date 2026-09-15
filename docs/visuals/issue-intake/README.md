# Review · GitHub intake

Work gets filed where the work is: an issue opened, a label put on one, a
comment left, a CI run that failed. Until now none of it reached Wanigan unless
somebody typed it into Review's event inbox by hand. GitHub pushes nothing to a
laptop with no public port, and Wanigan opens none, so intake asks: through the
operator's own `gh`, when they press **Check GitHub now**, and on a timer only if
they turn one on in Settings › Connections. Each new fact becomes an event in the
inbox, and **Create goal** turns one into a goal through the flow that already
existed. Nothing is ever written to GitHub.

A check is three facts, and the inbox shows all three:

| Mark | Meaning |
|---|---|
| ● fired | a press or the timer asked for a check, at this time |
| ▸ ran / – did not run | `gh` was invoked for the reads, or never was (no GitHub remote, no `gh`, another check still running) |
| ✓ succeeded / ✕ failed / ⊘ skipped | every read parsed and every new fact recorded; or a read failed, with Wanigan's reason and `gh`'s own first line; or the check stopped before running, with the reason |

What each poll reads, for the repository the project's remote names (`gh`'s own
remote order: a `gh repo set-default` choice, then upstream, github, origin):

| Kind | Read | Recorded when |
|---|---|---|
| + opened | `gh issue list --state=open --search=updated:>=…` | the issue was created inside the window |
| • labelled | the same list | a label Wanigan has not recorded on that issue before; the time it was added is not claimed |
| › commented | `gh api --method=GET repos/…/issues/comments?since=…` | an issue comment (not a pull request's) was created inside the window |
| ✕ CI failed | `gh run list --status=failure` | a run attempt failed and last changed inside the window |

Every read overlaps the last by five minutes, and each fact carries an external
key that is unique per project in SQLite, so a fact read twice is one event, and
a dismissed event does not come back. A failed read records nothing, and the next
check reads the same window again. Everything from GitHub is stripped of escapes,
controls and bidirectional overrides, redacted with `src/main/redact.ts`, and
bounded before it is stored.

**A closed laptop misses events, and says so.** The first check of a repository
reads the last day and says that nothing older is here. After that, a check whose
window started longer ago than the timer's interval records the gap, and Review
shows it as a warning: how long nothing was watching, and that an issue opened and
closed, a label added and removed, or a run re-run to green in that time is not
in the inbox. With the timer off, only presses watch, so the whole window counts.

The timer is off by default, refuses an interval under ten minutes rather than
clamping it, runs only while Wanigan is running, and records every poll it fires
exactly like a press. Rows in the inbox past the six it shows are now counted,
because one timed pass can add more than six.

## Screenshots

| | Dark | Light |
|---|---|---|
| Before · Review's event inbox | ![](before/review-inbox-dark.png) | ![](before/review-inbox-light.png) |
| Before · Settings › Connections | ![](before/settings-connections-dark.png) | ![](before/settings-connections-light.png) |
| After · a timed check that failed: not signed in, gh's words, the gap | ![](after/intake-dark.png) | ![](after/intake-light.png) |
| After · a timed check that succeeded after six hours unwatched | ![](after/succeeded-dark.png) | ![](after/succeeded-light.png) |
| After · GitHub events with their kind and Open on GitHub | ![](after/events-dark.png) | ![](after/events-light.png) |
| After · a press that found no gh: did not run, skipped | ![](after/skipped-dark.png) | ![](after/skipped-light.png) |
| After · the timer refusing nine minutes | ![](after/settings-refused-dark.png) | ![](after/settings-refused-light.png) |
| After · the timer on at twenty minutes | ![](after/settings-dark.png) | ![](after/settings-light.png) |

Rendered by `scripts/probe-issue-intake.mjs` in isolated Electron with synthetic
intake answers shaped like main's; before from `cf66478` (feat/merge-readiness),
exported with `git archive` and built in a scratch directory, after from this
change, same fixtures. `verification.json` in each directory lists the checks
that ran. The polls themselves — a fake `gh` against real repositories, every
honest state, dedupe across two polls, the gap, the timer, redaction — are the
smoke suite's `smoke25.ts`.

## Limits

- Timed-out and startup-failure runs are other `--status` values and are not
  asked for; only conclusion `failure` is CI failed.
- Each read stops at its limit (100 issues, 100 comments, 50 failed runs) and a
  check that reaches one says some may not be here.
- GitHub Enterprise Server hosts on custom domains are not recognised as GitHub;
  such a project is listed as not watched, with the host named.
- The timer does not survive a quit and does not run while this Mac sleeps; that
  is the gap the next check reports.
