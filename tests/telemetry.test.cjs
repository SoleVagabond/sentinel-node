const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSnapshot, health, historyForSnapshot } = require('../frontend/telemetry.js');
const timestamp = '2026-10-03T12:00:00Z';
const now = Date.parse(timestamp);
const snapshot = overrides => ({ schema_version: 1, mode: 'live', last_updated: timestamp, stale_after_seconds: 180, incidents: [], endpoints: [{ id: 'api', name: 'API', url: 'https://example.com', status: 'Green', latency_ms: 12 }], ...overrides });
test('recent healthy observations are operational', () => assert.equal(health(validateSnapshot(snapshot()), now + 5000).state, 'healthy'));
test('old successful observations become stale', () => assert.equal(health(snapshot(), now + 181000).state, 'stale'));
test('invalid timestamps do not appear healthy', () => assert.equal(health(snapshot({ last_updated: 'invalid' }), now).state, 'unknown'));
test('future timestamp outside allowed clock skew is unknown', () => assert.equal(health(snapshot(), now - 60000).state, 'unknown'));
test('outage takes precedence over slow response', () => assert.equal(health(snapshot({ endpoints: [{ status: 'Yellow' }, { status: 'Red' }] }), now).state, 'outage'));
test('slow response is degraded', () => assert.equal(health(snapshot({ endpoints: [{ status: 'Yellow' }] }), now).state, 'degraded'));
test('blocked monitor access is unknown rather than a website outage', () => assert.equal(health(snapshot({ endpoints: [{ status: 'Red', observer_error: true }] }), now).state, 'unknown'));
test('empty, duplicate, and malformed telemetry are rejected', () => {
  const good = snapshot();
  for (const data of [null, snapshot({ endpoints: [] }), snapshot({ endpoints: [...good.endpoints, ...good.endpoints] }), snapshot({ last_updated: 'bad' }), snapshot({ stale_after_seconds: 999999 }), snapshot({ endpoints: [{ ...good.endpoints[0], latency_ms: null }] })]) assert.throws(() => validateSnapshot(data));
});

const historySample = overrides => ({ timestamp, endpoints: [{ id: 'api', status: 'Green', latency_ms: 12, status_code: 200 }], ...overrides });
const historyData = samples => ({ schema_version: 1, samples });

test('history ahead of current status is omitted without altering original evidence', () => {
  const past = historySample({ timestamp: '2026-10-03T11:59:00Z' });
  const current = historySample();
  const future = historySample({ timestamp: '2026-10-03T12:01:00Z' });
  const data = historyData([past, current, future]);
  assert.deepEqual(historyForSnapshot(data, snapshot()), [past, current]);
  assert.deepEqual(data.samples, [past, current, future]);
});

test('malformed history is rejected including null samples, null rows and duplicate services', () => {
  const row = historySample().endpoints[0];
  for (const data of [null, {}, historyData([null]), historyData([historySample({ timestamp: 'bad' })]), historyData([historySample({ endpoints: [null] })]), historyData([historySample({ endpoints: [row, row] })]), historyData([historySample({ endpoints: [{ ...row, latency_ms: -1 }] })]), historyData([historySample({ endpoints: [{ ...row, status_code: '200' }] })])]) assert.throws(() => historyForSnapshot(data, snapshot()));
});

test('bounded history accepts empty history and a timed-out service with no HTTP response', () => {
  assert.deepEqual(historyForSnapshot(historyData([]), snapshot()), []);
  const timeout = historySample({ endpoints: [{ id: 'api', status: 'Red', latency_ms: 5000, status_code: null }] });
  assert.deepEqual(historyForSnapshot(historyData([timeout]), snapshot()), [timeout]);
  assert.throws(() => historyForSnapshot(historyData(Array.from({ length: 61 }, () => historySample())), snapshot()));
});
