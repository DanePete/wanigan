import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronForScheduleTiming, readScheduleTiming } from './schedule-timing.ts';

test('ordinary daily, weekday and weekly times round-trip without changing cadence', () => {
  for (const cron of ['0 0 * * *', '59 23 * * *', '30 10 * * 1-5', ...Array.from({ length: 7 }, (_, day) => `7 8 * * ${day}`)]) {
    const timing = readScheduleTiming(cron);
    assert.ok(timing);
    assert.equal(cronForScheduleTiming(timing), cron);
  }
});

test('complex, noncanonical and invalid expressions stay in the custom editor', () => {
  for (const cron of ['*/15 * * * *', '0 9 1 * *', '0 9 * * 1,3,5', '0 9 * * 7', '0 9 * * MON', ' 0 9 * * *', '0  9 * * *', '0 24 * * *', '60 9 * * *', 'broken', '']) {
    assert.equal(readScheduleTiming(cron), null, cron);
  }
});

test('incomplete or invalid time controls do not produce a runnable cron', () => {
  for (const time of ['', '10:', '9:30', '24:00', '10:60']) {
    assert.equal(cronForScheduleTiming({ repeat: 'daily', time, weekday: 1 }), null);
  }
  for (const weekday of [-1, 7, 1.5, NaN]) {
    assert.equal(cronForScheduleTiming({ repeat: 'weekly', time: '10:30', weekday }), null);
  }
  assert.equal(cronForScheduleTiming({ repeat: 'weekdays', time: '10:30', weekday: 1 }), '30 10 * * 1-5');
});
