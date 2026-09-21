import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { db, migrateSchema } from './db';
import * as otel from './otel';
import { automaticSpendVerdict } from '../shared/automatic-spend';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Attributes = Record<string, string>;
type Point = {
  value: number;
  at: string;
  start?: string;
  attrs?: Attributes;
};

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const attributes = (values: Attributes) => Object.entries(values).map(([key, value]) => attr(key, value));

/** The wire payload deliberately retains decimal nanoseconds beyond JS safe integers. */
function metrics(sessionId: string, points: Point[], options: {
  metric?: string; temporality?: number; omitTemporality?: boolean;
} = {}) {
  return {
    resourceMetrics: [{
      resource: { attributes: [attr('wanigan.session.id', sessionId), attr('service.name', 'accounting-fixture')] },
      scopeMetrics: [{ scope: { name: 'accounting-fixture', version: '1' }, metrics: [{
        name: options.metric ?? 'claude_code.cost.usage',
        sum: {
          ...(options.omitTemporality ? {} : { aggregationTemporality: options.temporality ?? 1 }),
          isMonotonic: true,
          dataPoints: points.map(point => ({
            asDouble: point.value,
            timeUnixNano: point.at,
            startTimeUnixNano: point.start ?? (BigInt(point.at) - 1_000_000_000n).toString(),
            attributes: attributes(point.attrs ?? { model: 'fixture-model' }),
          })),
        },
      }] }],
    }],
  };
}

function logs(sessionId: string, at: string, values: Attributes = {}) {
  return {
    resourceLogs: [{
      resource: { attributes: [attr('wanigan.session.id', sessionId)] },
      scopeLogs: [{ scope: { name: 'accounting-fixture', version: '1' }, logRecords: [{
        timeUnixNano: at,
        body: { stringValue: 'claude_code.api_request' },
        attributes: attributes({ model: 'fixture-model', ...values }),
      }] }],
    }],
  };
}

function migrationSmoke(check: Check): void {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`
      CREATE TABLE session_metrics (
        session_id TEXT NOT NULL, metric TEXT NOT NULL, attrs TEXT NOT NULL,
        value REAL NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
        PRIMARY KEY (session_id,metric,attrs)
      );
      CREATE TABLE session_api_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        at INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT,
        cost_usd REAL NOT NULL DEFAULT 0, duration_ms REAL,
        in_tokens INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
        effort TEXT, detail TEXT
      );
      INSERT INTO session_metrics VALUES ('legacy','claude_code.cost.usage','',0.75,1234);
      INSERT INTO session_api_events (session_id,at,kind,model,cost_usd)
        VALUES ('legacy',1234,'request','legacy-model',0.75);
    `);
    const oldMetrics = JSON.stringify(legacy.prepare('SELECT * FROM session_metrics').all());
    const oldEvents = JSON.stringify(legacy.prepare('SELECT * FROM session_api_events').all());
    migrateSchema(legacy);
    migrateSchema(legacy);
    check(JSON.stringify(legacy.prepare('SELECT session_id,metric,attrs,value,last_at FROM session_metrics').all()) === oldMetrics,
      'the additive telemetry migration preserves legacy dollar aggregates across repeated startup');
    check(JSON.stringify(legacy.prepare(`SELECT id,session_id,at,kind,model,cost_usd,duration_ms,
      in_tokens,out_tokens,cache_read,cache_write,effort,detail FROM session_api_events`).all()) === oldEvents,
    'the additive telemetry migration preserves legacy request evidence across repeated startup');
  } finally { legacy.close(); }
}

/** Real authenticated OTLP HTTP → durable SQLite → public usage reader → automatic admission. */
export async function runOtelAccountingSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── OTLP accounting · retry identity, explicit zero and complete cost coverage');
  migrationSmoke(check);
  const d = db();
  const prefix = `otel_accounting_${randomUUID()}`;
  const names = ['zero', 'empty-export', 'duplicate', 'integer-resource', 'precision', 'order', 'logs', 'cumulative', 'missing-temporality',
    'missing-time', 'bad-start', 'conflict', 'delayed', 'tokens', 'mixed-model', 'mixed-source',
    'ambiguous-source', 'lower-bound', 'legacy', 'legacy-tokens'];
  const ids = new Map(names.map(name => [name, `${prefix}_${name}`]));
  const id = (name: string): string => ids.get(name)!;
  const at = Date.now() - 60_000;
  const ns = (offset = 0): string => (BigInt(at + offset) * 1_000_000n).toString();
  const session = d.prepare(`INSERT INTO session_log
    (id,provider_id,backend_id,harness_id,project_path,project_name,started_at)
    VALUES (?,'claude','anthropic','claude-code','/synthetic/otel-accounting','OTLP accounting fixture',?)`);
  for (const sessionId of ids.values()) session.run(sessionId, at - 10_000);
  const alreadyRunning = otel.collectorPort() !== null;
  let port = await otel.startCollector();
  const send = async (endpoint: 'metrics' | 'logs', payload: unknown): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wanigan-token': otel.collectorToken() ?? '' },
      body: JSON.stringify(payload),
    });
    await response.text();
    if (!response.ok) throw new Error(`Accounting fixture ${endpoint} returned ${response.status}`);
  };
  const usage = (name: string) => otel.usageFor(id(name));
  const verdict = (name: string, budgetUsd = 1) => {
    const u = usage(name);
    return automaticSpendVerdict({ budgetUsd, spendUsd: u.costUsd,
      spendStatus: u.costStatus === 'reported' ? 'reported' : 'unreported' });
  };
  const unknown = (name: string): boolean => {
    const result = verdict(name);
    return !result.allowed && result.reason === 'unknown-spend';
  };
  const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;

  try {
    await send('metrics', metrics(id('zero'), [{ value: 0, at: ns() }]));
    check(usage('zero').costUsd === 0 && usage('zero').costStatus === 'reported'
      && usage('zero').lastAt === at && verdict('zero').allowed,
    'an explicit zero survives HTTP ingestion and permits the next action under a positive budget', usage('zero'));
    await send('metrics', metrics(id('empty-export'), [{ value: 0.2, at: ns() }]));
    await send('metrics', metrics(id('empty-export'), []));
    check(near(usage('empty-export').costUsd, 0.2) && usage('empty-export').costStatus === 'reported'
      && verdict('empty-export').allowed,
    'an empty delta export leaves already reported cost intact without inventing invalid activity', usage('empty-export'));

    const sourceBefore = otel.spendBySource(2).totals.costUsd;
    const original = metrics(id('duplicate'), [{ value: 0.4, at: ns(),
      attrs: { model: 'fixture-model', query_source: 'main', effort: 'high' } }]);
    await send('metrics', original);
    await send('metrics', original);
    const reordered = metrics(id('duplicate'), [{ value: 0.4, at: ns(),
      attrs: { effort: 'high', query_source: 'main', model: 'fixture-model' } }]);
    reordered.resourceMetrics[0].resource.attributes.reverse();
    await send('metrics', reordered);
    check(near(usage('duplicate').costUsd, 0.4)
      && near(otel.spendBySource(2).totals.costUsd - sourceBefore, 0.4),
    'retrying a dollar point with reordered attributes changes neither session nor source spend', usage('duplicate'));
    await send('metrics', metrics(id('duplicate'), [{ value: 0.4, at: ns(),
      attrs: { model: 'fixture-model', query_source: 'subagent', effort: 'high' } }]));
    check(near(usage('duplicate').costUsd, 0.8),
      'a distinct source in the same export interval counts even when its session rollup key matches', usage('duplicate'));
    const integerResource = (value: string | number) => {
      const group = metrics(id('integer-resource'), [{ value: 0.2, at: ns() }]).resourceMetrics[0];
      return { resourceMetrics: [{ ...group, resource: { attributes: [
        ...group.resource.attributes, { key: 'process.pid', value: { intValue: value } },
      ] } }] };
    };
    await send('metrics', integerResource('123'));
    await send('metrics', integerResource(123));
    check(near(usage('integer-resource').costUsd, 0.2) && usage('integer-resource').costStatus === 'reported',
      'equivalent string and numeric resource integers identify the same retried dollar point', usage('integer-resource'));

    const precise = ns();
    const nextNanosecond = (BigInt(precise) + 1n).toString();
    await send('metrics', metrics(id('precision'), [
      { value: 0.2, at: precise }, { value: 0.3, at: nextNanosecond, start: precise },
    ]));
    check(near(usage('precision').costUsd, 0.5),
      'distinct delta intervals one nanosecond apart survive integer precision and millisecond display rounding', usage('precision'));
    await send('metrics', metrics(id('order'), [{ value: 0.2, at: ns(2000) }]));
    await send('metrics', metrics(id('order'), [{ value: 0.3, at: ns() }]));
    check(near(usage('order').costUsd, 0.5) && usage('order').lastAt === at + 2000,
      'a legitimate older delta still adds while the displayed latest timestamp stays newest', usage('order'));

    const request = logs(id('logs'), precise, { input_tokens: '10', cost_usd: '0.1', 'request.id': 'first' });
    await send('logs', request);
    request.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.reverse();
    await send('logs', request);
    check(usage('logs').requests === 1 && otel.apiEvents(id('logs')).length === 1,
      'an identical request log with reordered attributes is recorded once', usage('logs'));
    await send('logs', logs(id('logs'), nextNanosecond, { input_tokens: '10', cost_usd: '0.1', 'request.id': 'first' }));
    check(usage('logs').requests === 2,
      'two request log timestamps one nanosecond apart remain separate requests', usage('logs'));

    for (const [name, options] of [
      ['cumulative', { temporality: 2 }],
      ['missing-temporality', { omitTemporality: true }],
    ] as const) {
      await send('metrics', metrics(id(name), [{ value: 0.2, at: ns() }]));
      await send('metrics', metrics(id(name), [{ value: 0.5, at: ns(1000) }], options));
      check(near(usage(name).costUsd, 0.2) && unknown(name),
        `a ${name} dollar export cannot add a false delta or leave earlier partial spend authorized`, usage(name));
      await send('metrics', metrics(id(name), [{ value: 0.1, at: ns(2000) }]));
      check(unknown(name), `a later valid delta cannot erase the unresolved ${name} export`, usage(name));
    }

    await send('metrics', metrics(id('missing-time'), [{ value: 0.2, at: ns() }]));
    const noTime = metrics(id('missing-time'), [{ value: 0.1, at: ns(1000) }]);
    Reflect.deleteProperty(noTime.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0], 'timeUnixNano');
    await send('metrics', noTime);
    check(unknown('missing-time'),
      'a cost point without an exporter timestamp cannot borrow receive time to authorize spend', usage('missing-time'));
    await send('metrics', metrics(id('bad-start'), [{ value: 0.2, at: ns() }]));
    await send('metrics', metrics(id('bad-start'), [{ value: 0.1, at: ns(1000), start: 'invalid-nanoseconds' }]));
    check(near(usage('bad-start').costUsd, 0.2) && unknown('bad-start'),
      'a malformed interval start is unresolved evidence rather than an absent optional timestamp', usage('bad-start'));

    await send('metrics', metrics(id('conflict'), [{ value: 0.2, at: ns() }]));
    await send('metrics', metrics(id('conflict'), [{ value: 0.4, at: ns() }]));
    check(near(usage('conflict').costUsd, 0.2) && unknown('conflict'),
      'a changed value for the same point identity is unresolved evidence rather than a second charge', usage('conflict'));

    await send('metrics', metrics(id('delayed'), [{ value: 0.2, at: ns() }]));
    await send('logs', logs(id('delayed'), ns(5000), { cost_usd: '2' }));
    check(near(usage('delayed').costUsd, 0.2) && unknown('delayed'),
      'a newer request blocks automatic work while its dollar metric is delayed', usage('delayed'));
    await send('metrics', metrics(id('delayed'), [{ value: 2, at: ns(5000) }]));
    const delayedVerdict = verdict('delayed');
    check(near(usage('delayed').costUsd, 2.2) && usage('delayed').costStatus === 'reported'
      && !delayedVerdict.allowed && delayedVerdict.reason === 'cap',
    'the delayed dollar delta resolves coverage and the actual total then enforces the cap', usage('delayed'));

    await send('metrics', metrics(id('tokens'), [{ value: 0.2, at: ns() }]));
    await send('metrics', metrics(id('tokens'), [{ value: 10, at: ns(1000),
      attrs: { model: 'fixture-model', type: 'input' } }], { metric: 'claude_code.token.usage' }));
    check(usage('tokens').inTokens === 10 && unknown('tokens'),
      'newer token activity also invalidates an earlier dollar meter without requiring a request log', usage('tokens'));
    await send('metrics', metrics(id('tokens'), [{ value: 0, at: ns(1000) }]));
    check(usage('tokens').costStatus === 'reported' && verdict('tokens').allowed,
      'an explicit matching-model zero can cover newer token activity', usage('tokens'));
    await send('metrics', metrics(id('tokens'), [{ value: 0, at: ns(2000),
      attrs: { model: 'fixture-model', type: 'input' } }], { metric: 'claude_code.token.usage' }));
    check(usage('tokens').inTokens === 10 && usage('tokens').costStatus === 'reported',
      'an idle zero-token delta does not invent newer paid activity after covered tokens', usage('tokens'));

    await send('metrics', metrics(id('mixed-model'), [{ value: 0.2, at: ns(), attrs: { model: 'model-a' } }]));
    await send('logs', logs(id('mixed-model'), ns(1000), { model: 'model-a', cost_usd: '0.1' }));
    await send('metrics', metrics(id('mixed-model'), [{ value: 0.3, at: ns(2000), attrs: { model: 'model-b' } }]));
    check(unknown('mixed-model'),
      'a newer meter for another model does not cover the first model’s outstanding request', usage('mixed-model'));
    await send('metrics', metrics(id('mixed-model'), [{ value: 0.1, at: ns(1000), attrs: { model: 'model-a' } }]));
    check(usage('mixed-model').costStatus === 'reported' && verdict('mixed-model').allowed,
      'the matching model’s late delta resolves coverage even after another model exported', usage('mixed-model'));

    const mainAttrs = { model: 'fixture-model', query_source: 'main' };
    const subagentAttrs = { model: 'fixture-model', query_source: 'subagent', 'agent.name': 'fixture-agent' };
    await send('metrics', metrics(id('mixed-source'), [{ value: 0.2, at: ns(), attrs: mainAttrs }]));
    await send('metrics', metrics(id('mixed-source'), [{ value: 100, at: ns(1000),
      attrs: { ...mainAttrs, type: 'input' } }], { metric: 'claude_code.token.usage' }));
    check(unknown('mixed-source'),
      'the main source’s newer token activity first marks its previous cost incomplete', usage('mixed-source'));
    await send('metrics', metrics(id('mixed-source'), [{ value: 0, at: ns(2000), attrs: subagentAttrs }]));
    check(unknown('mixed-source'),
      'a newer subagent dollar meter cannot cover outstanding main activity for the same model', usage('mixed-source'));
    await send('metrics', metrics(id('mixed-source'), [{ value: 0.1, at: ns(1000), attrs: mainAttrs }]));
    check(near(usage('mixed-source').costUsd, 0.3) && usage('mixed-source').costStatus === 'reported',
      'the main source’s own late dollar delta resolves its outstanding activity', usage('mixed-source'));

    await send('metrics', metrics(id('ambiguous-source'), [{ value: 0.2, at: ns(), attrs: mainAttrs }]));
    await send('logs', logs(id('ambiguous-source'), ns(1000), { cost_usd: '0.1' }));
    await send('metrics', metrics(id('ambiguous-source'), [{ value: 0, at: ns(2000), attrs: subagentAttrs }]));
    check(unknown('ambiguous-source'),
      'a request log without a source cannot be cleared by a newer unmatched subagent meter', usage('ambiguous-source'));
    await send('metrics', metrics(id('ambiguous-source'), [{ value: 0.1, at: ns(1000), attrs: mainAttrs }]));
    check(usage('ambiguous-source').costStatus === 'reported',
      'an ambiguous-source log is covered once every candidate source has caught up', usage('ambiguous-source'));

    await send('logs', logs(id('lower-bound'), ns(), { cost_usd: '0.8' }));
    await send('metrics', metrics(id('lower-bound'), [{ value: 0.2, at: ns(1000) }]));
    check(near(usage('lower-bound').costUsd, 0.2) && unknown('lower-bound'),
      'a newer but smaller dollar total cannot cover a larger explicit request-log cost', usage('lower-bound'));
    await send('metrics', metrics(id('lower-bound'), [{ value: 0.6, at: ns(2000) }]));
    check(near(usage('lower-bound').costUsd, 0.8) && usage('lower-bound').costStatus === 'reported',
      'catching up to the known request amount resolves coverage without double-adding log dollars', usage('lower-bound'));

    d.prepare('INSERT INTO session_metrics (session_id,metric,attrs,value,last_at) VALUES (?,?,?,?,?)')
      .run(id('legacy'), 'claude_code.cost.usage', '', 0.75, at);
    check(usage('legacy').costUsd === 0.75 && usage('legacy').costStatus === 'reported',
      'legacy dollar aggregates retain their reported reading when no contradictory activity is present', usage('legacy'));
    const legacyMetric = d.prepare('INSERT INTO session_metrics (session_id,metric,attrs,value,last_at) VALUES (?,?,?,?,?)');
    legacyMetric.run(id('legacy-tokens'), 'claude_code.cost.usage', '{"model":"fixture-model"}', 0.2, at);
    legacyMetric.run(id('legacy-tokens'), 'claude_code.token.usage', '{"model":"fixture-model","type":"input"}', 10, at + 1000);
    const legacyWasIncomplete = unknown('legacy-tokens');
    await send('metrics', metrics(id('legacy-tokens'), [{ value: 0, at: ns(2000),
      attrs: { model: 'fixture-model', type: 'input' } }], { metric: 'claude_code.token.usage' }));
    check(legacyWasIncomplete && usage('legacy-tokens').inTokens === 10 && unknown('legacy-tokens'),
      'a new idle token point preserves outstanding activity from the legacy aggregate', usage('legacy-tokens'));
    await send('metrics', metrics(id('legacy-tokens'), [{ value: 0, at: ns(1000) }]));
    check(usage('legacy-tokens').costStatus === 'reported' && near(usage('legacy-tokens').costUsd, 0.2),
      'a matching dollar point can cover the legacy positive tokens without requiring coverage of later idle exports', usage('legacy-tokens'));

    otel.stopCollector();
    port = await otel.startCollector();
    await send('metrics', original);
    await send('logs', request);
    check(near(usage('duplicate').costUsd, 0.8) && usage('logs').requests === 2,
      'collector restart preserves retry identity for dollar points and request logs');
    check(unknown('cumulative') && unknown('conflict'),
      'collector restart also preserves unresolved protocol and conflicting-value evidence');
  } finally {
    if (!alreadyRunning) otel.stopCollector();
    for (const sessionId of ids.values()) {
      for (const table of ['session_telemetry_receipts', 'session_telemetry_issues', 'session_telemetry_coverage',
        'session_spend_sources', 'session_api_events', 'session_metrics', 'session_log']) {
        d.prepare(`DELETE FROM ${table} WHERE ${table === 'session_log' ? 'id' : 'session_id'}=?`).run(sessionId);
      }
    }
  }
}
