/* Dashboard consumes published telemetry; demo controls exist only on the local server. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const labels = { Green: 'Operational', Yellow: 'Degraded', Red: 'Outage', Unknown: 'Unknown' };
  let snapshot = null;
  let history = [];
  let offline = false;
  let refreshPromise = null;
  let controlBusy = false;
  let demoEnabled = false;
  let currentScenario = '';
  let renderedFingerprint = '';
  let deliveryFingerprint = '';
  let lastTestId = null;
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

  function refresh() {
    if (!refreshPromise) refreshPromise = performRefresh().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function refreshAfterControl() {
    // A polling request started before the change may contain the old state.
    if (refreshPromise) await refreshPromise;
    await refresh();
  }

  async function performRefresh() {
    $('refresh-btn').disabled = true; $('refresh-btn').textContent = 'Checking…';
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
      $('refresh-btn').disabled = false; $('refresh-btn').textContent = 'Refresh'; render();
    }
  }

  function renderDeliveries(data) {
    if (data?.schema_version !== 1 || !Array.isArray(data.deliveries) || !Array.isArray(data.receipts) || !data.summary) throw new Error('Invalid delivery history');
    const fingerprint = JSON.stringify(data);
    const { pending, delivered, failed } = data.summary;
    if (![pending, delivered, failed].every(value => Number.isInteger(value) && value >= 0)) throw new Error('Invalid delivery counts');
    $('delivery-message').textContent = `${pending} pending · ${delivered} delivered · ${failed} failed. Retries wait for their due time; permanent failures stop automatically.`;
    const testDelivery = data.deliveries.find(row => row?.event?.id === lastTestId);
    if (testDelivery) showTestResult(testDelivery);
    $('receiver-state').textContent = {
      available: 'Current receiver: available. New notifications can be acknowledged.',
      unavailable: 'Current receiver: unavailable. New deliveries receive HTTP 503 and remain queued for retry.',
      'lose-next-response': 'Current receiver: next reply will be lost after acceptance. Retry uses the same event reference.'
    }[data.receiver_mode] || 'Receiver state unavailable.';
    if (fingerprint === deliveryFingerprint) return;
    // Build the complete view first; malformed optional delivery data leaves health independent.
    const rows = [...data.deliveries].reverse().slice(0, 12).map(item => {
      if (!['pending', 'delivered', 'failed'].includes(item.status) || !['opened', 'escalated', 'recovered', 'test'].includes(item.event?.type) || !Number.isInteger(item.attempts)) throw new Error('Invalid delivery');
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
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No notifications yet. Send a test notification or trigger an incident.'; rows.push(empty); }
    $('deliveries-list').replaceChildren(...rows);
    document.querySelectorAll('[data-receiver]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.receiver === data.receiver_mode)));
    deliveryFingerprint = fingerprint;
  }

  async function changeReceiver(event) {
    const button = event.target.closest('button');
    if (!button || !demoEnabled || controlBusy || (!button.dataset.receiver && !['retry-deliveries', 'send-test-notification'].includes(button.id))) return;
    const buttons = setControlsBusy(true);
    lastTestId = null;
    $('notification-action').textContent = button.dataset.receiver ? 'Changing receiver…' : button.id === 'send-test-notification' ? 'Sending test notification…' : 'Checking due deliveries…';
    try {
      const route = button.dataset.receiver ? 'api/receiver' : button.id === 'send-test-notification' ? 'api/test-notification' : 'api/retry';
      const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(button.dataset.receiver ? { mode: button.dataset.receiver } : {}), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Receiver control failed');
      const result = await response.json();
      if (button.dataset.receiver) {
        $('notification-action').textContent = {
          available: 'Receiver available. Send a test notification or retry pending deliveries.',
          unavailable: 'Receiver unavailable. Send a test notification to see it queue for retry.',
          'lose-next-response': 'Next reply will be lost after acceptance. Send a test notification to try it.'
        }[button.dataset.receiver];
      } else if (button.id === 'send-test-notification') {
        const row = result.delivery;
        lastTestId = row.event.id;
        showTestResult(row);
      } else {
        $('notification-action').textContent = result.attempted ? `Retried ${result.attempted} notification${result.attempted === 1 ? '' : 's'}; ${result.acknowledged} acknowledged. ${result.summary.pending} still pending.` : result.summary.pending ? 'No deliveries due yet. Pending notifications are waiting for their next retry time.' : `No pending notifications to retry.${result.summary.failed ? ' Failed records have stopped and require inspection.' : ' Send a test notification to try delivery.'}`;
      }
      await refreshAfterControl();
    } catch (_) { $('notification-action').textContent = 'The action could not be confirmed. Refresh delivery history before trying again.'; }
    finally { setControlsBusy(false, buttons); if (document.activeElement === document.body) button.focus({ preventScroll: true }); }
  }

  function showTestResult(row) {
    $('notification-action').textContent = row.status === 'delivered' ? 'Test notification delivered and acknowledged by the local receiver.' : row.status === 'pending' ? `Test notification queued. ${row.last_error || 'Waiting for delivery'}. Retry eligible ${dateLabel(row.next_attempt_at)}.` : 'Test delivery stopped. Inspect its failed record below.';
  }

  function setControlsBusy(value, buttons = [...document.querySelectorAll('[data-scenario], #notification-lab button')]) {
    controlBusy = value;
    buttons.forEach(item => { item.disabled = value; });
    return buttons;
  }

  function setScenarioUI(scenario) {
    currentScenario = scenario;
    document.querySelectorAll('[data-scenario]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario)));
  }

  async function chooseScenario(event) {
    const button = event.target.closest('[data-scenario]');
    if (!button || !demoEnabled || controlBusy) return;
    const buttons = setControlsBusy(true);
    try {
      const response = await fetch('api/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: button.dataset.scenario }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Scenario change failed');
      setScenarioUI(button.dataset.scenario);
      $('scenario-message').textContent = currentScenario === 'stale' ? 'Telemetry paused. Last observations remain visible, but current health is unknown.' : currentScenario === 'recovered' ? 'A fresh healthy check resolves open incidents. The timeline keeps their history.' : `Scenario: ${button.textContent} · local services checked every 5 seconds`;
      await refreshAfterControl();
    } catch (_) { $('scenario-message').textContent = 'Could not change the demo. Try again.'; }
    finally {
      setControlsBusy(false, buttons);
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
