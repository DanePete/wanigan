import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextFire } from './cron.ts';

function inZone(zone: string, run: () => void): void {
  const prior = process.env.TZ;
  process.env.TZ = zone;
  try { run(); } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
}

test('autumn repeated wall-clock minutes never yield a past fire or run twice', () => {
  inZone('America/Chicago', () => {
    const secondHour = Date.parse('2026-11-01T07:10:00Z');
    assert.equal(nextFire('* * * * *', secondHour), Date.parse('2026-11-01T08:00:00Z'));
    assert.equal(nextFire('30 1 * * *', secondHour), Date.parse('2026-11-02T07:30:00Z'));
    const first = nextFire('30 1 * * *', Date.parse('2026-11-01T05:00:00Z'))!;
    assert.equal(first, Date.parse('2026-11-01T06:30:00Z'));
    assert.equal(nextFire('30 1 * * *', first), Date.parse('2026-11-02T07:30:00Z'));
  });
});

test('spring-forward missing times fire at the first real minute after the gap', () => {
  inZone('America/Chicago', () => {
    assert.equal(nextFire('30 2 * * *', Date.parse('2026-03-08T07:00:00Z')), Date.parse('2026-03-08T08:00:00Z'));
    assert.equal(nextFire('30 2 * * *', Date.parse('2026-03-08T08:00:00Z')), Date.parse('2026-03-09T07:30:00Z'));
  });
});

test('half-hour autumn changes also skip the repeated wall-clock interval', () => {
  inZone('Australia/Lord_Howe', () => {
    const repeated = Date.parse('2026-04-04T15:10:00Z');
    assert.equal(nextFire('* * * * *', repeated), Date.parse('2026-04-04T15:30:00Z'));
  });
});

test('ordinary cron steps, calendar limits, and strict minute rounding remain stable', () => {
  inZone('UTC', () => {
    const from = Date.parse('2026-06-01T09:07:59.999Z');
    assert.equal(nextFire('* * * * *', from), Date.parse('2026-06-01T09:08:00Z'));
    assert.equal(nextFire('*/15 * * * *', from), Date.parse('2026-06-01T09:15:00Z'));
    assert.equal(nextFire('0 9 * * 1-5', Date.parse('2026-06-06T12:00:00Z')), Date.parse('2026-06-08T09:00:00Z'));
    assert.equal(nextFire('0 0 29 2 *', Date.parse('2026-03-01T00:00:00Z')), Date.parse('2028-02-29T00:00:00Z'));
    assert.equal(nextFire('0 0 30 2 *', from), null);
  });
});
