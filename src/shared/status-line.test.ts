/**
 * The status line's pure half. The payload below is shaped exactly as the
 * 2.1.270 binary builds it (eRs/oRs, read 2026-09-14): rate_limits windows in
 * epoch seconds, prompt_cache with its miss attribution, effort.level, pr and
 * prompt_id, surrounded by the fields Wanigan deliberately does not keep.
 *
 * The subject is the same as every other honesty test here: an absent window
 * must stay absent, and a forecast must refuse before it guesses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cmdQuote, curlConfig, FORECAST_MIN_SPAN_MS, forecastSentence, forecastWindow, limitJumps, MISS_CAUSE_LABELS, parseStatusLine, readingKey, shellQuote,
  statusLineCommand, summarizeWindow, windowEnvelope, type LimitSample,
} from './status-line.ts';

const RESET_5H = 1_789_000_000;
const RESET_7D = 1_789_400_000;

const PAYLOAD = {
  session_id: 'b6a1c9f0-0000-4000-8000-000000000000',
  prompt_id: '0d6c2b1e-1111-4222-8333-444455556666',
  transcript_path: '/Users/someone/.claude/projects/-work-repo/b6a1.jsonl',
  cwd: '/work/repo',
  session_name: 'refactor the checkout',
  model: { id: 'claude-opus-5', display_name: 'Opus 5' },
  workspace: { current_dir: '/work/repo', project_dir: '/work/repo', added_dirs: [] },
  version: '2.1.270',
  cost: { total_cost_usd: 3.14, total_duration_ms: 10_000, total_api_duration_ms: 8_000, total_lines_added: 1, total_lines_removed: 0 },
  context_window: { total_input_tokens: 1200, used_percentage: 12 },
  prompt_cache: {
    warm: true, caching_observed: true, ttl: '1h', expires_at: 1_788_990_000, requests: 41, misses: 2,
    expected_rebuilds: 1, hit_ratio: 0.87, cache_write_tokens: 91_000, miss_recache_tokens: 42_000,
    last_miss_at: 1_788_980_000, last_miss_cause: { causes: ['tools_changed'], tools_added: 2, tools_removed: 0 },
    miss_causes: { tools_changed: 1, ttl_expired_5m: 1 }, recache_tokens_if_cold: 64_000,
  },
  effort: { level: 'xhigh' },
  thinking: { enabled: true },
  rate_limits: {
    five_hour: { used_percentage: 42.4, resets_at: RESET_5H },
    seven_day: { used_percentage: 61, resets_at: RESET_7D },
  },
  pr: { number: 1234, url: 'https://github.com/example/repo/pull/1234', review_state: 'pending' },
};

test('a full payload keeps the windows, cache, effort, pr, prompt id and version, in milliseconds', () => {
  const r = parseStatusLine(PAYLOAD)!;
  assert.deepEqual(r.windows, {
    five_hour: { usedPercent: 42.4, resetsAt: RESET_5H * 1000 },
    seven_day: { usedPercent: 61, resetsAt: RESET_7D * 1000 },
  });
  assert.equal(r.cliVersion, '2.1.270');
  assert.equal(r.effort, 'xhigh');
  assert.equal(r.promptId, PAYLOAD.prompt_id);
  assert.deepEqual(r.pr, { number: 1234, url: 'https://github.com/example/repo/pull/1234', reviewState: 'pending' });
  assert.equal(r.cache?.hitRatio, 0.87);
  assert.equal(r.cache?.expiresAt, 1_788_990_000 * 1000);
  assert.deepEqual(r.cache?.lastMissCauses, ['tools_changed']);
  assert.deepEqual(r.cache?.missCauses, [{ cause: 'tools_changed', count: 1 }, { cause: 'ttl_expired_5m', count: 1 }]);
});

test('nothing path-shaped, named or priced from the payload survives into the reading', () => {
  const kept = JSON.stringify(parseStatusLine(PAYLOAD));
  for (const leaked of ['/work/repo', 'refactor the checkout', 'claude-opus-5', '3.14', '.jsonl']) {
    assert(!kept.includes(leaked), `${leaked} must not be kept`);
  }
});

test('an absent window stays absent: an API-key payload has no rate_limits and reads no windows at all', () => {
  const { rate_limits: _dropped, ...apiKey } = PAYLOAD;
  assert.deepEqual(parseStatusLine(apiKey)!.windows, {});
  const oneWindow = parseStatusLine({ ...PAYLOAD, rate_limits: { five_hour: PAYLOAD.rate_limits.five_hour } })!;
  assert.deepEqual(Object.keys(oneWindow.windows), ['five_hour']);
  assert.equal(oneWindow.windows.seven_day, undefined);
});

test('a window with a missing or impossible field is dropped whole rather than half-kept', () => {
  const r = parseStatusLine({ rate_limits: {
    five_hour: { used_percentage: 12 },
    seven_day: { used_percentage: 140, resets_at: RESET_7D },
    spend_limit: { used_percentage: 140, resets_at: RESET_7D },
  } })!;
  assert.equal(r.windows.five_hour, undefined, 'no reset time, no window');
  assert.equal(r.windows.seven_day, undefined, 'a subscription window cannot read above 100');
  assert.equal(r.windows.spend_limit?.usedPercent, 140, 'a gateway spend limit is documented as exceeding 100');
});

test('a payload that is not an object is refused; an empty object is a reading with nothing in it', () => {
  assert.equal(parseStatusLine(null), null);
  assert.equal(parseStatusLine('[]'), null);
  assert.equal(parseStatusLine([1, 2]), null);
  assert.deepEqual(parseStatusLine({}), { cliVersion: null, windows: {}, effort: null, pr: null, promptId: null, cache: null });
});

test('hostile strings in bounded fields are dropped, not stored', () => {
  const r = parseStatusLine({
    version: '2.1.270; rm -rf /', effort: { level: 'x'.repeat(40) }, prompt_id: '../../etc',
    // Assembled, so the linter's script-URL rule does not read the fixture as code.
    pr: { number: 7, url: ['javascript', 'alert(1)'].join(':'), review_state: 'DROP TABLE' },
    prompt_cache: { ttl: '1 hour', miss_causes: { 'tools changed': 3, ok_cause: -1 }, last_miss_cause: { causes: ['a b', 'ok_cause'] } },
  })!;
  assert.equal(r.cliVersion, null);
  assert.equal(r.effort, null);
  assert.equal(r.promptId, null);
  assert.deepEqual(r.pr, { number: 7, url: null, reviewState: null });
  assert.equal(r.cache?.ttl, null);
  assert.deepEqual(r.cache?.missCauses, []);
  assert.deepEqual(r.cache?.lastMissCauses, ['ok_cause']);
});

test('two readings that differ only in prompt id fold into one key', () => {
  const a = parseStatusLine(PAYLOAD)!;
  const b = parseStatusLine({ ...PAYLOAD, prompt_id: '99999999-1111-4222-8333-444455556666' })!;
  const c = parseStatusLine({ ...PAYLOAD, rate_limits: { ...PAYLOAD.rate_limits, five_hour: { used_percentage: 43, resets_at: RESET_5H } } })!;
  assert.equal(readingKey(a), readingKey(b));
  assert.notEqual(readingKey(a), readingKey(c));
});

test('every cause the CLI documents has the CLI’s own words', () => {
  for (const cause of ['system_prompt_changed', 'tools_changed', 'model_changed', 'messages_rewritten', 'ttl_expired_5m', 'ttl_expired_1h', 'likely_server_side', 'unknown']) {
    assert.equal(typeof MISS_CAUSE_LABELS[cause], 'string', cause);
  }
});

/* ── forecast ── */

const MIN = 60_000;
const T0 = 1_788_000_000_000;
const RESET = T0 + 5 * 60 * MIN;
const s = (minute: number, usedPercent: number, resetsAt = RESET): LimitSample => ({ at: T0 + minute * MIN, usedPercent, resetsAt });

test('the forecast refuses with no reading and with a single reading', () => {
  assert.deepEqual(forecastWindow([], T0), { state: 'insufficient', samples: 0, spanMs: 0 });
  const one = forecastWindow([s(0, 40)], T0 + MIN);
  assert.equal(one.state, 'insufficient');
  assert.equal(one.state === 'insufficient' && one.samples, 1);
});

test('two readings closer together than the minimum span are not a rate', () => {
  const close = forecastWindow([s(0, 40), s(9, 44)], T0 + 9 * MIN);
  assert.equal(close.state, 'insufficient');
  assert.equal(close.state === 'insufficient' && close.spanMs < FORECAST_MIN_SPAN_MS, true);
});

test('a steady rise over the lookback lands at the straight-line crossing of 100%', () => {
  // 40% → 52% over 12 minutes is 1 point a minute; 48 points left is 48 minutes.
  const f = forecastWindow([s(0, 40), s(6, 46), s(12, 52)], T0 + 12 * MIN);
  assert.equal(f.state, 'reaches');
  assert.equal(f.state === 'reaches' && f.at, T0 + 60 * MIN);
  assert.equal(f.state === 'reaches' && f.perHour, 60);
});

test('only the last 30 minutes set the rate, and a reading from before a reset is never fitted', () => {
  const older = s(-50, 0);
  const otherWindow = s(-20, 99, RESET - 5 * 60 * MIN);
  const f = forecastWindow([older, otherWindow, s(0, 40), s(12, 52)], T0 + 12 * MIN);
  assert.equal(f.state === 'reaches' && f.perHour, 60, JSON.stringify(f));
});

test('a rate that fills after the reset says the reset comes first', () => {
  const f = forecastWindow([s(0, 10), s(20, 11)], T0 + 20 * MIN);
  assert.equal(f.state, 'resets-first');
});

test('a flat or falling window has no crossing', () => {
  assert.equal(forecastWindow([s(0, 40), s(15, 40)], T0 + 15 * MIN).state, 'flat');
  assert.equal(forecastWindow([s(0, 40), s(15, 38)], T0 + 15 * MIN).state, 'flat');
});

test('a full window is exhausted, a passed reset is a reset, and an old reading is stale — none of them forecast', () => {
  assert.equal(forecastWindow([s(0, 90), s(15, 100)], T0 + 15 * MIN).state, 'exhausted');
  assert.equal(forecastWindow([s(0, 40), s(15, 50)], RESET + 1).state, 'reset');
  assert.equal(forecastWindow([s(0, 40), s(15, 50)], T0 + 90 * MIN).state, 'stale');
});

test('a jump of ten points between consecutive readings is flagged, newest first, and a reset is not a jump', () => {
  const samples = [s(0, 10), s(5, 12), s(52, 30), s(55, 31), s(60, 5, RESET + 5 * 60 * MIN), s(62, 20, RESET + 5 * 60 * MIN)];
  assert.deepEqual(limitJumps(samples), [
    { fromPercent: 5, toPercent: 20, fromAt: T0 + 60 * MIN, toAt: T0 + 62 * MIN },
    { fromPercent: 12, toPercent: 30, fromAt: T0 + 5 * MIN, toAt: T0 + 52 * MIN },
  ]);
  assert.deepEqual(limitJumps([s(0, 10), s(5, 19.9)]), []);
});

test('an idle session’s lower reading neither drags the figure down nor reads as a jump when the busy one speaks again', () => {
  // The busy session climbs 40 → 46 → 52; an idle one keeps re-reporting the 40
  // it last heard from the provider.
  const mixed = [s(0, 40), s(4, 40), s(6, 46), s(8, 40), s(12, 52), s(13, 40)];
  const env = windowEnvelope(mixed);
  assert.deepEqual(env.map((p) => p.usedPercent), [40, 40, 46, 46, 52, 52]);
  assert.deepEqual(limitJumps(env), []);
  const w = summarizeWindow('five_hour', mixed, T0 + 13 * MIN)!;
  assert.equal(w.usedPercent, 52);
  assert.equal(w.observedAt, T0 + 12 * MIN, 'the age is the reading that carried 52, not the later stale 40');
  assert.equal(w.readings, 6);
});

test('a window with no reading summarises to nothing, and the envelope never mixes two windows', () => {
  assert.equal(summarizeWindow('seven_day', [], T0), null);
  const next = RESET + 5 * 60 * MIN;
  const env = windowEnvelope([s(0, 90), s(310, 3, next), s(320, 5, next)]);
  assert.deepEqual(env.map((p) => p.usedPercent), [3, 5], 'the 90 from before the reset is not a floor under the new window');
});

test('the forecast is drawn through the envelope, so a steady climb with stale readings between still reaches 100%', () => {
  const w = summarizeWindow('five_hour', [s(0, 40), s(3, 38), s(6, 46), s(9, 41), s(12, 52)], T0 + 12 * MIN)!;
  assert.equal(w.forecast.state, 'reaches');
  assert.equal(w.forecast.state === 'reaches' && w.forecast.at, T0 + 60 * MIN);
});

test('the forecast sentence refuses in words, marks a crossing as approximate and every reset as observed', () => {
  const clock = (at: number) => `@${(at - T0) / MIN}`;
  const ago = () => '42m ago';
  assert.equal(forecastSentence(forecastWindow([s(0, 40)], T0 + MIN), clock, ago),
    'Not enough observations to forecast: one reading in the last 30 minutes, and a forecast needs 2.');
  assert.equal(forecastSentence(forecastWindow([s(0, 40), s(4, 41)], T0 + 4 * MIN), clock, ago),
    'Not enough observations to forecast: 2 readings spanning 4 min, and a forecast needs at least 10.');
  assert.equal(forecastSentence(forecastWindow([s(0, 40), s(6, 46), s(12, 52)], T0 + 12 * MIN), clock, ago),
    'At the last 30 minutes\' observed rate, reaches 100% ≈ @60; resets @300 (observed).');
  assert.match(forecastSentence(forecastWindow([s(0, 40), s(15, 50)], T0 + 90 * MIN), clock, ago), /arrived 42m ago/);
});

/* ── relay quoting ── */

test('a shell word survives spaces and single quotes through /bin/sh -c', () => {
  assert.equal(shellQuote('/Users/a/Library/Application Support/wanigan/relay.sh'),
    `'/Users/a/Library/Application Support/wanigan/relay.sh'`);
  assert.equal(shellQuote(`it's`), `'it'\\''s'`);
});

test('the injected command quotes every path, carries the bound, and holds no token', () => {
  const cmd = statusLineCommand({
    relay: '/Users/a/Library/Application Support/wanigan/statusline/relay.sh', curl: '/usr/bin/curl',
    config: '/Users/a/Library/Application Support/wanigan/statusline/s_1.curl',
    chain: '/Users/a/Library/Application Support/wanigan/statusline/s_1.chain',
  });
  assert.equal(cmd, `'/Users/a/Library/Application Support/wanigan/statusline/relay.sh' '/usr/bin/curl' `
    + `'/Users/a/Library/Application Support/wanigan/statusline/s_1.curl' `
    + `'/Users/a/Library/Application Support/wanigan/statusline/s_1.chain' 5`);
  assert.match(statusLineCommand({ relay: 'r', curl: 'c', config: 'k', chain: 'h', boundSeconds: 999 }), / 60$/);
});

test('the Windows command names an interpreter, because a .ps1 is not a program', () => {
  const win = statusLineCommand({
    relay: 'C:\\Users\\dane\\AppData\\Roaming\\wanigan\\statusline\\relay.ps1',
    curl: 'C:\\Windows\\System32\\curl.exe',
    config: 'C:\\Users\\dane\\AppData\\Roaming\\wanigan\\statusline\\s_1.curl',
    chain: 'C:\\Users\\dane\\AppData\\Roaming\\wanigan\\statusline\\s_1.chain',
    platform: 'win32',
  });
  assert.equal(win,
    'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '
    + '"C:\\Users\\dane\\AppData\\Roaming\\wanigan\\statusline\\relay.ps1" '
    + '"C:\\Windows\\System32\\curl.exe" '
    + '"C:\\Users\\dane\\AppData\\Roaming\\wanigan\\statusline\\s_1.curl" '
    + '"C:\\Users\\dane\\AppData\\Roaming\\wanigan\\statusline\\s_1.chain" 5');
  // -File and not -Command: everything after -File is an argument rather than
  // more script, which is the difference between a path and an injection point.
  assert.ok(win.includes('-File'));
  assert.ok(!win.includes('-Command'));
  // Single quotes would be four arguments beginning with an apostrophe here.
  assert.ok(!win.includes("'"));
});

test('a status line path that could break cmd.exe quoting is refused, not escaped', () => {
  assert.equal(cmdQuote('C:\\Program Files\\Wanigan\\relay.ps1'), '"C:\\Program Files\\Wanigan\\relay.ps1"');
  assert.throws(() => cmdQuote('C:\\od"d\\relay.ps1'), /double quote/);
});

test('the curl config carries the bearer as a header, refuses proxies, and cannot be split into a second directive', () => {
  const cap = 'A'.repeat(43);
  const conf = curlConfig({ port: 4312, capability: cap });
  assert.match(conf, /^url = "http:\/\/127\.0\.0\.1:4312\/statusline"$/m);
  assert.match(conf, new RegExp(`^header = "Authorization: Bearer ${cap}"$`, 'm'));
  assert.match(conf, /^noproxy = "\*"$/m);
  assert.match(conf, /^max-time = 1$/m);
  assert.throws(() => curlConfig({ port: 4312, capability: 'x"\nurl = "http://elsewhere' }));
  assert.throws(() => curlConfig({ port: 0, capability: cap }));
  assert.equal(curlConfig({ port: 1, capability: 'a"b\\c' }).includes('Bearer a\\"b\\\\c"'), true);
});
