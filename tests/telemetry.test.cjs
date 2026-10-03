const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSnapshot, health } = require('../frontend/telemetry.js');
const timestamp = '2026-10-03T12:00:00Z';
const now = Date.parse(timestamp);
const snapshot = overrides => ({ schema_version: 1, mode: 'live', last_updated: timestamp, stale_after_seconds: 180, incidents: [], endpoints: [{ id: 'api', name: 'API', url: 'https://example.com', status: 'Green', latency_ms: 12 }], ...overrides });
test('recent healthy observations are operational', () => assert.equal(health(validateSnapshot(snapshot()), now + 5000).state, 'healthy'));
test('old successful observations become stale', () => assert.equal(health(snapshot(), now + 181000).state, 'stale'));
test('invalid timestamps do not appear healthy', () => assert.equal(health(snapshot({ last_updated: 'invalid' }), now).state, 'unknown'));
test('future timestamp outside allowed clock skew is unknown', () => assert.equal(health(snapshot(), now - 60000).state, 'unknown'));
test('outage takes precedence over slow response', () => assert.equal(health(snapshot({ endpoints: [{ status: 'Yellow' }, { status: 'Red' }] }), now).state, 'outage'));
test('slow response is degraded', () => assert.equal(health(snapshot({ endpoints: [{ status: 'Yellow' }] }), now).state, 'degraded'));
test('empty, duplicate, and malformed telemetry are rejected', () => {
  const good = snapshot();
  for (const data of [null, snapshot({ endpoints: [] }), snapshot({ endpoints: [...good.endpoints, ...good.endpoints] }), snapshot({ last_updated: 'bad' }), snapshot({ stale_after_seconds: 999999 }), snapshot({ endpoints: [{ ...good.endpoints[0], latency_ms: null }] })]) assert.throws(() => validateSnapshot(data));
});
