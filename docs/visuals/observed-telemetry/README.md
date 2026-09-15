# Observed telemetry · limits, traces and spend by source

Three things Claude Code already reports about itself, which Wanigan was either
guessing at or not reading at all.

**Limits from the status line.** The CLI hands its status line command the
provider's own five-hour and seven-day windows (used percentage and reset time),
plus its prompt cache's view of itself. Wanigan's injected `--settings` file now
names a relay script in Wanigan's user-data directory. On every render the relay
copies the JSON into a private scratch file and POSTs it to the hook listener
with `curl -q -K <0600 config>`, so the session's bearer is in no argument
vector and no `~/.curlrc` or proxy can redirect it. It then runs the operator's
own status line, resolved from their settings chain for the account the session
actually runs on, with the same stdin, and prints exactly what that prints. The
chained command is bounded at five seconds (TERM, then KILL) and prints nothing
if it overruns. If there is no status line of their own, the relay prints nothing.
Nothing is written into the repository or `~/.claude`.

Readings are stored per session and per account. A window the CLI did not send
is stored as absent, never as zero. An API-key login has no windows, and the
Usage view says so instead of estimating. Beside each Claude account's `/usage`
probe card, the view states each observed window with its age ("Observed from a
live session's status line, 4m ago · resets 00:34 (observed)"). It forecasts a
crossing of 100% only from two or more readings at least ten minutes apart in
the last half hour, and otherwise says why not. A rise of ten points or more
between consecutive readings is flagged. Readings from a session that has not
heard from the provider lately are lower, never higher, so the figure and the
forecast are drawn through the running maximum rather than zigzagging between
sessions. The session's Timeline gains a prompt cache readout: hit ratio,
misses with the CLI's own cause names, TTL and expiry.

**Per-prompt waterfalls.** Behind Settings › Privacy & data › *Record per-prompt
traces (beta)*, off by default, launches get `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`
and a trace exporter pinned by its signal-specific variables to the loopback
collector. The collector stores spans in an additive table, pruned by the event
retention setting, after dropping every attribute that carries prompt, response,
tool input, command or error text, every identity attribute, span events and
status messages. Each turn on the Timeline draws its model requests, tool calls
and waits on you, offset from the prompt. A turn killed mid-flight is marked
incomplete and names what is missing; a traced session's turn with no spans says
"No trace recorded for this turn".

**Spend by source.** The CLI's cost and token metrics carry `query_source`,
`skill.name`, `plugin.name`, `mcp_server.name`, `agent.name`, `effort` and
`speed`. They are now stored in their own table, bucketed by local day, in the
same transaction as the existing totals. Insights › Spending has a *Spend by
source* table: main, subagent and auxiliary, then by skill, plugin, MCP server
and subagent. Unattributed spend is kept as its own row, so every grouping adds
back to the total. Spend on a backend nobody bills at the CLI's price is shown
apart as "unbilled". The table says plainly that these are the CLI's own
estimates, and that user-defined and third-party names read `custom` or
`third-party` unless tool details are logged.

The smoke suite (`src/main/smoke18.ts`) runs the relay exactly as the CLI does
(`/bin/sh -c`, payload on stdin) against the real listener and collector. It
checks that a wrong or missing bearer is refused, the 0700 and 0600 modes, and
that the bearer never appears in curl's recorded argv. It checks that the
chained output survives byte for byte, including colour codes, and that a
TERM-ignoring hang returns in about two seconds with exit 124. It also covers
absent windows, the one-reading forecast refusal, OTLP span sanitising and
retry idempotence, retention, and attribution totals.

## Screenshots

| | Dark | Light |
|---|---|---|
| Before · Usage | ![](before/usage-dark.png) | ![](before/usage-light.png) |
| After · observed limits, forecast, jump, one-reading refusal | ![](after/usage-observed-dark.png) | ![](after/usage-observed-light.png) |
| After · an account whose status lines carried no windows | ![](after/usage-no-windows-dark.png) | ![](after/usage-no-windows-light.png) |
| After · observations could not be read | ![](after/usage-failed-dark.png) | ![](after/usage-failed-light.png) |
| Before · Timeline | ![](before/timeline-dark.png) | ![](before/timeline-light.png) |
| After · per-prompt waterfall | ![](after/timeline-waterfall-dark.png) | ![](after/timeline-waterfall-light.png) |
| After · prompt cache readout | ![](after/timeline-cache-dark.png) | ![](after/timeline-cache-light.png) |
| After · no trace for a turn, and a trace killed mid-flight | ![](after/timeline-incomplete-dark.png) | ![](after/timeline-incomplete-light.png) |
| Before · Insights › Spending | ![](before/insights-dark.png) | ![](before/insights-light.png) |
| After · spend by source | ![](after/insights-spend-by-source-dark.png) | ![](after/insights-spend-by-source-light.png) |

Rendered by `scripts/probe-observed-telemetry.mjs` in isolated Electron with
synthetic readings, spans and spend. The before shots come from `dba7528` in a
detached worktree, and the after shots from this change, with the same fixtures.
`verification.json` in each directory lists the checks that ran.
