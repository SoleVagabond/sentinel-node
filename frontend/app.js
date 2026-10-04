/* Dashboard consumes published telemetry; demo controls exist only on the local server. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const labels = { Green: 'Operational', Yellow: 'Degraded', Red: 'Outage', Unknown: 'Unknown' };
  let snapshot = null;
  let history = [];
  let offline = false;
  let busy = false;
  let demoEnabled = false;
  let currentScenario = '';
  let renderedFingerprint = '';
  let deliveryFingerprint = '';
  const dateLabel = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const secondsLabel = seconds => seconds < 60 ? `${Math.floor(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  function render() {
    const state = snapshot ? SentinelTelemetry.health(snapshot) : { state: 'unknown', label: 'Waiting for telemetry', age: null };
    const trustworthy = snapshot && !offline && !['stale', 'unknown'].includes(state.state);
    $('global-status').dataset.state = offline ? 'unknown' : state.state;
    const statusText = offline ? 'Telemetry unavailable' : state.label;
    if ($('global-status-text').textContent !== statusText) $('global-status-text').textContent = statusText;
    $('telemetry-age').textContent = state.age === null ? '—' : secondsLabel(state.age);
    $('service-count').textContent = snapshot ? snapshot.endpoints.length : '—';
    $('healthy-count').textContent = trustworthy ? snapshot.endpoints.filter(item => item.status === 'Green').length : '—';
    $('incident-count').textContent = trustworthy ? snapshot.incidents.filter(item => item.resolved_at === null).length : '—';
    $('last-updated').textContent = snapshot ? `Last completed check: ${dateLabel(snapshot.last_updated)}` : 'No completed check available.';
    const warning = offline ? 'Cannot load current telemetry. Previous observations are shown as unknown until the connection recovers.' : state.state === 'stale' ? 'The monitor has stopped reporting. Service health is unknown; these are the last observed results.' : state.state === 'unknown' && snapshot ? 'The telemetry timestamp is not trustworthy. Check the monitor clock.' : '';
    $('notice').hidden = !warning;
    if ($('notice').textContent !== warning) $('notice').textContent = warning;
    if (!snapshot) { $('endpoint-grid').replaceChildren(); return; }
    const fingerprint = `${snapshot.last_updated}|${state.state}|${offline}|${history.length}|${history.at(-1)?.timestamp}`;
    if (fingerprint === renderedFingerprint) return;
    renderedFingerprint = fingerprint;
    const cards = snapshot.endpoints.map(endpoint => {
      const clone = $('card-template').content.cloneNode(true);
      const status = trustworthy ? endpoint.status : 'Unknown';
      clone.querySelector('.card').dataset.status = status;
      clone.querySelector('.endpoint-name').textContent = endpoint.name;
      clone.querySelector('.endpoint-url').textContent = endpoint.url;
      clone.querySelector('.status-indicator').textContent = labels[status];
      clone.querySelector('.status-code').textContent = endpoint.status_code ?? 'No response';
      clone.querySelector('.latency').textContent = `${Math.round(endpoint.latency_ms)} ms`;
      const error = clone.querySelector('.error-message');
      error.hidden = !endpoint.error;
      error.textContent = endpoint.error || '';
      const samples = history.map(sample => ({ timestamp: sample.timestamp, row: sample.endpoints.find(row => row.id === endpoint.id) })).filter(sample => sample.row).slice(-30);
      for (const sample of samples) {
        const bar = document.createElement('span');
        bar.dataset.status = sample.row.status;
        bar.title = `${dateLabel(sample.timestamp)} · ${labels[sample.row.status]} · ${Math.round(sample.row.latency_ms)} ms`;
        bar.setAttribute('aria-hidden', 'true');
        clone.querySelector('.sample-history').append(bar);
      }
      const success = samples.filter(sample => sample.row.status === 'Green').length;
      const caption = samples.length ? `${success}/${samples.length} recent checks operational` : 'History unavailable';
      clone.querySelector('.history-caption').textContent = trustworthy ? caption : `Last observed: ${labels[endpoint.status]} · ${caption}`;
      return clone;
    });
    $('endpoint-grid').replaceChildren(...cards);
    renderIncidents(trustworthy);
    $('environment-label').textContent = snapshot.mode === 'demo' ? 'Local demonstration · sample services · no cloud resources' : 'Live monitoring · configured services';
  }

  function renderIncidents(trustworthy) {
    const items = [...snapshot.incidents].sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at)).slice(0, 12);
    if (!items.length) {
      const message = document.createElement('p'); message.className = 'empty'; message.textContent = 'No incidents recorded in this monitoring session.';
      $('incidents-list').replaceChildren(message); return;
    }
    $('incidents-list').replaceChildren(...items.map(incident => {
      const row = document.createElement('article'); row.className = 'incident-row';
      const badge = document.createElement('span'); badge.className = `incident-badge ${incident.resolved_at ? 'resolved' : 'active'}`; badge.textContent = incident.resolved_at ? 'Recovered' : trustworthy ? 'Active' : 'Last active';
      const detail = document.createElement('div');
      const name = document.createElement('h3'); name.textContent = incident.name;
      const reason = document.createElement('p'); reason.textContent = incident.reason;
      const dates = document.createElement('p'); dates.className = 'incident-dates'; dates.textContent = `Started ${dateLabel(incident.opened_at)}${incident.resolved_at ? ` · Recovered ${dateLabel(incident.resolved_at)}` : ' · Awaiting a healthy check'}`;
      detail.append(name, reason, dates); row.append(badge, detail); return row;
    }));
  }

  async function refresh() {
    if (busy) return;
    busy = true; $('refresh-btn').disabled = true; $('refresh-btn').textContent = 'Checking…';
    const requests = [fetchJson('status_data.json'), fetchJson('history.json')];
    if (demoEnabled) requests.push(fetchJson('demo-config.json'), fetchJson('alerts.json'));
    const results = await Promise.allSettled(requests);
    try {
      if (results[0].status !== 'fulfilled') throw new Error('Telemetry request failed');
      snapshot = SentinelTelemetry.validateSnapshot(results[0].value);
      offline = false;
      // Missing or malformed optional history must not invalidate a valid current observation.
      try {
        history = results[1].status === 'fulfilled' ? SentinelTelemetry.historyForSnapshot(results[1].value, snapshot) : [];
      } catch (_) { history = []; }
      if (results[2]?.status === 'fulfilled') setScenarioUI(results[2].value.scenario);
    } catch (_) { offline = true; }
    finally {
      if (demoEnabled) {
        try {
          if (results[3]?.status !== 'fulfilled') throw new Error('Delivery history unavailable');
          renderDeliveries(results[3].value);
        } catch (_) { $('delivery-message').textContent = 'Delivery history unavailable. Previously loaded records may be out of date.'; }
      }
      busy = false; $('refresh-btn').disabled = false; $('refresh-btn').textContent = 'Refresh'; render();
    }
  }

  function renderDeliveries(data) {
    if (data?.schema_version !== 1 || !Array.isArray(data.deliveries) || !Array.isArray(data.receipts) || !data.summary) throw new Error('Invalid delivery history');
    const fingerprint = JSON.stringify(data);
    const { pending, delivered, failed } = data.summary;
    if (![pending, delivered, failed].every(value => Number.isInteger(value) && value >= 0)) throw new Error('Invalid delivery counts');
    $('delivery-message').textContent = `${pending} pending · ${delivered} delivered · ${failed} failed. Retries wait for their due time; permanent failures stop automatically.`;
    if (fingerprint === deliveryFingerprint) return;
    // Build the complete view first; malformed optional delivery data leaves health independent.
    const rows = [...data.deliveries].reverse().slice(0, 12).map(item => {
      if (!['pending', 'delivered', 'failed'].includes(item.status) || !['opened', 'escalated', 'recovered'].includes(item.event?.type) || !Number.isInteger(item.attempts)) throw new Error('Invalid delivery');
      const row = document.createElement('article'); row.className = 'incident-row delivery-row';
      const badge = document.createElement('span'); badge.className = `incident-badge ${item.status === 'delivered' ? 'resolved' : 'active'}`; badge.textContent = item.status[0].toUpperCase() + item.status.slice(1);
      const detail = document.createElement('div');
      const name = document.createElement('h3'); name.textContent = `${item.event.type[0].toUpperCase() + item.event.type.slice(1)} · ${item.event.name}`;
      const attempts = document.createElement('p'); attempts.textContent = `${item.attempts} attempt${item.attempts === 1 ? '' : 's'}${item.last_error ? ` · ${item.last_error}` : ''}`;
      const date = document.createElement('p'); date.className = 'incident-dates'; date.textContent = item.status === 'delivered' ? `Acknowledged ${dateLabel(item.delivered_at)}` : item.status === 'pending' ? `Next eligible retry ${dateLabel(item.next_attempt_at)}` : 'Delivery stopped. Inspect the receiver before taking further action.';
      detail.append(name, attempts, date); row.append(badge, detail); return row;
    });
    const requests = data.receipts.reduce((sum, row) => sum + row.requests, 0);
    $('receiver-summary').textContent = `Receiver retained ${data.receipts.length} unique notifications from ${requests} accepted HTTP requests. Duplicate references are counted without accepting another notification.`;
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No notifications yet. Trigger a slow response or API outage.'; rows.push(empty); }
    $('deliveries-list').replaceChildren(...rows);
    document.querySelectorAll('[data-receiver]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.receiver === data.receiver_mode)));
    deliveryFingerprint = fingerprint;
  }

  async function changeReceiver(event) {
    const button = event.target.closest('button');
    if (!button || !demoEnabled || (!button.dataset.receiver && button.id !== 'retry-deliveries')) return;
    const buttons = [...$('notification-lab').querySelectorAll('button')];
    const scenarios = [...document.querySelectorAll('[data-scenario]')];
    buttons.forEach(item => { item.disabled = true; });
    scenarios.forEach(item => { item.disabled = true; });
    try {
      const response = await fetch(button.dataset.receiver ? 'api/receiver' : 'api/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(button.dataset.receiver ? { mode: button.dataset.receiver } : {}), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Receiver control failed');
      await refresh();
    } catch (_) { $('delivery-message').textContent = 'Could not update the receiver. Try again.'; }
    finally { buttons.forEach(item => { item.disabled = false; }); scenarios.forEach(item => { item.disabled = false; }); if (document.activeElement === document.body) button.focus({ preventScroll: true }); }
  }

  function setScenarioUI(scenario) {
    currentScenario = scenario;
    document.querySelectorAll('[data-scenario]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario)));
  }

  async function chooseScenario(event) {
    const button = event.target.closest('[data-scenario]');
    if (!button || !demoEnabled) return;
    const buttons = [...document.querySelectorAll('[data-scenario]')];
    buttons.forEach(item => { item.disabled = true; });
    try {
      const response = await fetch('api/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: button.dataset.scenario }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Scenario change failed');
      setScenarioUI(button.dataset.scenario);
      $('scenario-message').textContent = currentScenario === 'stale' ? 'Telemetry paused. Last observations remain visible, but current health is unknown.' : currentScenario === 'recovered' ? 'A fresh healthy check resolves open incidents. The timeline keeps their history.' : `Scenario: ${button.textContent} · local services checked every 5 seconds`;
      await refresh();
    } catch (_) { $('scenario-message').textContent = 'Could not change the demo. Try again.'; }
    finally {
      buttons.forEach(item => { item.disabled = false; });
      if (document.activeElement === document.body) button.focus({ preventScroll: true });
    }
  }

  async function start() {
    try {
      const config = await fetchJson('demo-config.json');
      demoEnabled = config.mode === 'demo';
      if (demoEnabled) { $('demo-panel').hidden = false; $('notification-lab').hidden = false; setScenarioUI(config.scenario); }
    } catch (_) { /* Failed environment configuration leaves demo controls disabled. */ }
    $('refresh-btn').addEventListener('click', refresh);
    $('demo-panel').addEventListener('click', chooseScenario);
    $('notification-lab').addEventListener('click', changeReceiver);
    await refresh();
    setInterval(refresh, demoEnabled ? 5000 : 15000);
    setInterval(render, 1000);
  }
  start();
})();
