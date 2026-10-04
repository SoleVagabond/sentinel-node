(function (root) {
  'use strict';
  function validateSnapshot(data) {
    if (!data || data.schema_version !== 1 || !['live', 'demo'].includes(data.mode) || !Array.isArray(data.endpoints) || data.endpoints.length < 1 || data.endpoints.length > 8 || !Array.isArray(data.incidents)) throw new Error('Invalid telemetry format');
    if (!Number.isFinite(Date.parse(data.last_updated)) || !Number.isFinite(data.stale_after_seconds) || data.stale_after_seconds < 1 || data.stale_after_seconds > 3600) throw new Error('Invalid telemetry timestamp or freshness limit');
    const ids = new Set();
    for (const item of data.endpoints) {
      if (!item || typeof item.id !== 'string' || ids.has(item.id) || typeof item.name !== 'string' || typeof item.url !== 'string' || !['Green', 'Yellow', 'Red'].includes(item.status) || !Number.isFinite(item.latency_ms) || item.latency_ms < 0) throw new Error('Invalid endpoint telemetry');
      ids.add(item.id);
    }
    for (const item of data.incidents) {
      if (!item || typeof item.name !== 'string' || !Number.isFinite(Date.parse(item.opened_at)) || (item.resolved_at !== null && !Number.isFinite(Date.parse(item.resolved_at)))) throw new Error('Invalid incident telemetry');
    }
    return data;
  }
  function health(data, now = Date.now()) {
    const age = (now - Date.parse(data.last_updated)) / 1000;
    if (!Number.isFinite(age) || age < -30) return { state: 'unknown', label: 'Invalid telemetry time', age: null };
    if (age > data.stale_after_seconds) return { state: 'stale', label: 'Telemetry is stale', age };
    if (data.endpoints.some(item => item.observer_error === true)) return { state: 'unknown', label: 'Monitor network access unavailable', age: Math.max(0, age) };
    if (data.endpoints.some(item => item.status === 'Red')) return { state: 'outage', label: 'Service outage detected', age: Math.max(0, age) };
    if (data.endpoints.some(item => item.status === 'Yellow')) return { state: 'degraded', label: 'Service response degraded', age: Math.max(0, age) };
    return { state: 'healthy', label: 'All services operational', age: Math.max(0, age) };
  }
  function historyForSnapshot(data, snapshot) {
    if (!data || data.schema_version !== 1 || !Array.isArray(data.samples) || data.samples.length > 60) throw new Error('Invalid history format');
    for (const sample of data.samples) {
      if (!sample || !Number.isFinite(Date.parse(sample.timestamp)) || !Array.isArray(sample.endpoints) || sample.endpoints.length < 1 || sample.endpoints.length > 8) throw new Error('Invalid history sample');
      const ids = new Set();
      for (const row of sample.endpoints) {
        if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id) || !['Green', 'Yellow', 'Red'].includes(row.status) || !Number.isFinite(row.latency_ms) || row.latency_ms < 0 || (row.status_code !== null && (!Number.isInteger(row.status_code) || row.status_code < 100 || row.status_code > 599))) throw new Error('Invalid history endpoint');
        ids.add(row.id);
      }
    }
    const completedAt = Date.parse(snapshot.last_updated);
    if (!Number.isFinite(completedAt)) throw new Error('Invalid snapshot timestamp');
    // History and current status are separate writes. Never imply a newer check completed.
    return data.samples.filter(sample => Date.parse(sample.timestamp) <= completedAt);
  }
  const api = { validateSnapshot, health, historyForSnapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SentinelTelemetry = api;
})(typeof window !== 'undefined' ? window : this);
