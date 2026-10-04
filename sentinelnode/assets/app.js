(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let data = null, offline = false, refreshJob = null, actionBusy = false, confirmAction = null, renderedKind = null;
  const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : 'Not yet checked';
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const badge = (text, kind) => element('span', text, `badge ${kind || ''}`);
  function button(text, action, id, className) {
    const node = element('button', text, className); node.type = 'button'; node.dataset.action = action; if (id) node.dataset.id = id;
    node.dataset.focusKey = `${action}:${id || ''}`; return node;
  }
  function empty(container, message) { container.replaceChildren(element('p', message, 'empty')); }
  function replace(container, nodes) {
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    container.replaceChildren(...nodes);
    if (focused) [...container.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }
  function message(text, error = false) { $('action-message').textContent = text; $('action-message').classList.toggle('error', error); }
  async function request(url, payload) {
    const options = { cache: 'no-store', signal: AbortSignal.timeout(15000) };
    if (payload !== undefined) Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sentinel-CSRF': data?.csrf || '' }, body: JSON.stringify(payload) });
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }
  function refresh() {
    if (!refreshJob) refreshJob = (async () => {
      try { data = await request('api/state'); offline = false; render(); }
      catch (_) { offline = true; $('connection').textContent = 'Connection unavailable'; if (data) render(); else message('Cannot load the workspace. Check the application, then reload.', true); }
    })().finally(() => { refreshJob = null; });
    return refreshJob;
  }
  async function action(url, payload, form) {
    if (actionBusy) return false;
    actionBusy = true;
    const controls = [...document.querySelectorAll('button')]; controls.forEach(node => { node.disabled = true; });
    message('Working…');
    try {
      const result = await request(url, payload);
      if (form) form.dataset.dirty = 'false';
      if (refreshJob) await refreshJob;
      await refresh();
      message(result.message || 'Saved.');
      return true;
    } catch (error) {
      const text = error.name === 'TimeoutError' ? 'The action could not be confirmed. Reload its saved state before trying again.' : error.message;
      message(text, true);
      if (form && form.closest('dialog')) form.querySelector('.form-error').textContent = text;
      return false;
    } finally {
      actionBusy = false; controls.forEach(node => { node.disabled = false; });
      $('check-now').disabled = !data || data.runner.running;
    }
  }
  function showView(view, updateHash = true) {
    if (!['overview', 'services', 'incidents', 'notifications', 'history', 'settings'].includes(view)) view = 'overview';
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== view; });
    document.querySelectorAll('[data-view]').forEach(node => { if (node.dataset.view === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    if (updateHash) history.replaceState(null, '', `#${view}`);
    if (view === 'history' && data) loadHistory();
  }
  function status() {
    const config = data.config, snapshot = data.snapshot;
    if (offline) return { kind: 'unknown', label: 'Connection unavailable', detail: 'Previous observations are retained. Current service health is unknown.' };
    if (!config.services.length) return { kind: 'unknown', label: 'Add your first service', detail: 'Configure an HTTP service to start recording checks, incidents, and response times.' };
    if (!config.services.some(row => row.enabled)) return { kind: 'unknown', label: 'All services paused', detail: 'Resume a service from Services to continue monitoring. Its history is retained.' };
    if (!config.monitoring_enabled) return { kind: 'unknown', label: 'Scheduled checks paused', detail: 'Last observations remain available. Use Check now for a manual observation or resume the schedule in Settings.' };
    if (data.runner.error) return { kind: 'unknown', label: 'Monitor needs attention', detail: data.runner.error };
    if (!snapshot.last_updated) return { kind: 'unknown', label: 'Waiting for a completed check', detail: 'The scheduler is running. You can also use Check now.' };
    const age = (Date.now() - Date.parse(snapshot.last_updated)) / 1000;
    if (!Number.isFinite(age) || age < -30) return { kind: 'unknown', label: 'Observation time is not trustworthy', detail: 'Check the monitor clock.' };
    if (age > config.interval_seconds * 3) return { kind: 'stale', label: 'Monitoring is stale', detail: 'The monitor has stopped producing fresh observations. Current service health is unknown.' };
    const enabled = config.services.filter(row => row.enabled);
    const rows = enabled.map(service => snapshot.endpoints.find(row => row.id === service.id && row.url === service.url));
    if (rows.some(row => !row)) return { kind: 'unknown', label: 'Waiting for updated checks', detail: 'A service has changed or was just added. Its next completed check will establish its health.' };
    const kind = rows.some(row => row.status === 'Red') ? 'outage' : rows.some(row => row.status === 'Yellow') ? 'degraded' : 'healthy';
    if (kind === 'outage' && rows.filter(row => row.status === 'Red').every(row => [401, 403].includes(row.status_code))) return { kind, label: 'Service access denied', detail: 'The endpoint rejected the monitor’s request. It may require authorized access or block automated clients.' };
    return { kind, label: { outage: 'Service outage detected', degraded: 'Slow service response detected', healthy: 'Checked services operational' }[kind],
      detail: `${enabled.length} enabled service${enabled.length === 1 ? '' : 's'} · ${config.services.length - enabled.length} paused · every ${config.interval_seconds} seconds` };
  }
  function render() {
    const config = data.config, snapshot = data.snapshot, current = status();
    renderedKind = current.kind;
    $('connection').textContent = offline ? 'Connection unavailable' : data.demo ? 'Local demo' : 'Local workspace';
    $('check-now').disabled = actionBusy || data.runner.running;
    $('check-now').textContent = data.runner.running ? 'Checking…' : 'Check now';
    $('demo-banner').hidden = !data.demo;
    if (data.demo) { $('demo-scenario').value = data.demo.scenario; $('demo-receiver').value = data.demo.receiver; }
    $('health-banner').dataset.state = current.kind;
    $('health-label').textContent = current.label; $('health-detail').textContent = current.detail;
    $('last-check').textContent = snapshot.last_updated ? `Last completed check ${date(snapshot.last_updated)}` : 'No completed check';
    $('service-total').textContent = config.services.length;
    const trustworthy = ['healthy', 'outage', 'degraded'].includes(current.kind);
    $('operational-total').textContent = trustworthy ? (snapshot.endpoints || []).filter(row => row.status === 'Green' && config.services.some(service => service.id === row.id && service.enabled)).length : '—';
    $('incident-total').textContent = data.incidents.filter(row => !row.resolved_at).length;
    $('pending-total').textContent = data.deliveries.filter(row => row.status === 'pending').length;
    $('delivery-setting').textContent = config.notifications_enabled ? 'Delivery enabled' : config.webhook_url ? 'Delivery paused' : 'Not configured';
    $('token-status').textContent = data.token_configured ? 'Bearer token is configured in this process.' : 'No bearer token configured.';
    $('runner-status').textContent = `${data.runner.running ? 'Check in progress.' : 'Ready.'} Last scheduler activity: ${date(data.runner.last_tick)}${data.runner.error ? ` ${data.runner.error}` : ''}`;
    renderCards(trustworthy); renderServices(); renderIncidents(); renderDeliveries(); populateSettings();
    const historyValue = $('history-service').value;
    $('history-service').replaceChildren(element('option', 'All services'));
    $('history-service').firstChild.value = '';
    for (const row of config.services) { const option = element('option', row.name); option.value = row.id; $('history-service').append(option); }
    $('history-service').value = historyValue;
  }
  function renderCards(trustworthy) {
    if (!data.config.services.length) { empty($('service-cards'), 'Your workspace is ready. Open Services and add the first service you want to monitor.'); return; }
    replace($('service-cards'), data.config.services.map(service => {
      const observed = data.snapshot.endpoints?.find(row => row.id === service.id && row.url === service.url);
      const card = element('article', undefined, 'service-card');
      const top = element('div', undefined, 'card-top'); top.append(element('h3', service.name));
      const label = !service.enabled ? 'Paused' : !observed ? 'Not checked' : !trustworthy ? 'Last observed' : observed.status === 'Red' && [401, 403].includes(observed.status_code) ? 'Access denied' : { Green: 'Operational', Yellow: 'Degraded', Red: 'Outage' }[observed.status];
      top.append(badge(label, trustworthy && service.enabled ? observed?.status : 'Unknown'));
      card.append(top, element('p', service.url, 'url'));
      const readings = element('div', undefined, 'readings'); readings.append(element('span', `HTTP ${observed?.status_code ?? '—'}`), element('span', observed ? `${Math.round(observed.latency_ms)} ms` : 'No observation'));
      card.append(readings); if (observed?.error) card.append(element('p', observed.error, 'muted small'));
      if (observed?.status === 'Red' && [401, 403].includes(observed.status_code)) card.append(element('p', 'This endpoint rejected the automated check. Inspect its access requirements.', 'muted small'));
      return card;
    }));
  }
  function renderServices() {
    if (!data.config.services.length) { empty($('services-list'), 'No services configured. Add a service to start real HTTP checks.'); return; }
    replace($('services-list'), data.config.services.map(row => {
      const item = element('article', undefined, 'journal-row'); const heading = element('div', undefined, 'journal-heading');
      heading.append(element('h3', row.name), badge(row.enabled ? 'Enabled' : 'Paused', row.enabled ? 'Green' : 'Unknown'));
      const buttons = element('div', undefined, 'buttons'); buttons.append(button('Edit service', 'edit-service', row.id), button(row.enabled ? 'Pause service' : 'Resume service', row.enabled ? 'pause' : 'resume', row.id), button('View history', 'history-service', row.id), button('Remove service', 'remove', row.id, 'danger'));
      item.append(heading, element('p', row.url), element('p', `Expected HTTP ${row.expected_statuses.join(', ')} · timeout ${row.timeout_seconds}s · slow above ${row.degraded_after_ms}ms`, 'muted small'), buttons); return item;
    }));
  }
  function incidentRow(row) {
    const item = element('article', undefined, 'journal-row'); const heading = element('div', undefined, 'journal-heading');
    const label = row.resolution === 'monitoring_stopped' ? 'Monitoring stopped' : row.resolved_at ? 'Recovered' : 'Open';
    heading.append(element('h3', row.name), badge(label, row.resolution === 'monitoring_stopped' ? 'Unknown' : row.resolved_at ? 'recovered' : 'open'));
    item.append(heading, element('p', row.reason), element('p', `Opened ${date(row.opened_at)}${row.resolved_at ? ` · Closed ${date(row.resolved_at)}` : ''}`));
    item.append(element('p', row.acknowledged_at ? `Acknowledged ${date(row.acknowledged_at)}` : 'Not acknowledged'));
    if (row.note) item.append(element('p', `Note: ${row.note}`));
    const buttons = element('div', undefined, 'buttons'); buttons.append(button('Respond to incident', 'incident', row.id)); item.append(buttons); return item;
  }
  function renderIncidents() {
    const filter = $('incident-filter').value;
    const selected = data.incidents.filter(row => filter === 'all' || filter === 'open' && !row.resolved_at || filter === 'resolved' && row.resolved_at || filter === 'unacknowledged' && !row.resolved_at && !row.acknowledged_at);
    if (selected.length) replace($('incident-list'), selected.map(incidentRow)); else empty($('incident-list'), 'No incidents match this view.');
    const open = data.incidents.filter(row => !row.resolved_at).slice(0, 4);
    if (open.length) replace($('open-incidents'), open.map(incidentRow)); else empty($('open-incidents'), 'No open incidents. Confirmed recoveries remain in incident history.');
  }
  function renderDeliveries() {
    const filter = $('delivery-filter').value;
    const selected = data.deliveries.filter(row => filter === 'all' || row.status === filter);
    if (!selected.length) { empty($('delivery-list'), 'No deliveries match this view. Configure a receiver and send a test to exercise delivery.'); return; }
    replace($('delivery-list'), selected.map(row => {
      const item = element('article', undefined, 'journal-row'); const heading = element('div', undefined, 'journal-heading');
      heading.append(element('h3', `${row.event.type[0].toUpperCase() + row.event.type.slice(1)} · ${row.event.name}`), badge(row.status === 'delivered' ? 'Acknowledged' : row.status === 'pending' ? 'Pending' : 'Failed', row.status));
      item.append(heading, element('p', `${row.total_attempts} total attempt${row.total_attempts === 1 ? '' : 's'} · ${row.attempts}/5 in this retry cycle${row.last_error ? ` · ${row.last_error}` : ''}`));
      item.append(element('p', row.status === 'pending' ? `Next eligible retry ${date(row.next_attempt_at)}` : row.status === 'delivered' ? `Acknowledged ${date(row.delivered_at)}` : 'Automatic retries stopped. Inspect the receiver before retrying.'));
      item.append(element('p', `Reference ${row.event.id}`, 'muted small'));
      if (row.status === 'failed' && row.replayable) { const buttons = element('div', undefined, 'buttons'); buttons.append(button('Retry failed notification', 'replay', row.event.id)); item.append(buttons); }
      else if (row.status === 'failed') item.append(element('p', 'Archived record. It has aged out of the replay window.', 'muted small'));
      return item;
    }));
  }
  function populateSettings(forceForm) {
    const config = data.config;
    for (const id of ['settings-form', 'webhook-form']) {
      const form = $(id);
      if (forceForm !== id && (form.dataset.dirty === 'true' || form.dataset.revision === String(config.revision))) continue;
      form.dataset.revision = config.revision; form.dataset.dirty = 'false';
      if (id === 'settings-form') { $('interval-seconds').value = config.interval_seconds; $('retention-days').value = config.retention_days; $('monitoring-enabled').checked = config.monitoring_enabled; }
      else { $('webhook-url').value = config.webhook_url; $('webhook-enabled').checked = config.notifications_enabled; }
    }
  }
  function editService(id) {
    const row = data.config.services.find(item => item.id === id);
    $('service-form').dataset.revision = data.config.revision;
    $('service-dialog-heading').textContent = row ? 'Edit service' : 'Add service';
    $('service-id').value = row?.id || ''; $('service-name').value = row?.name || ''; $('service-url').value = row?.url || '';
    $('service-timeout').value = row?.timeout_seconds || 5; $('service-threshold').value = row?.degraded_after_ms || 1000;
    $('service-codes').value = row?.expected_statuses.join(', ') || '200'; $('service-enabled').checked = row?.enabled ?? true; $('service-error').textContent = '';
    $('service-dialog').showModal(); $('service-name').focus();
  }
  function editIncident(id) {
    const row = data.incidents.find(item => item.id === id);
    $('incident-id').value = row.id; $('incident-description').textContent = `${row.name} · ${row.reason} · opened ${date(row.opened_at)}`;
    $('incident-acknowledge').checked = !!row.acknowledged_at; $('incident-note').value = row.note; $('incident-error').textContent = '';
    $('incident-dialog').showModal();
  }
  function confirm(title, detail, callback) {
    $('confirm-heading').textContent = title; $('confirm-detail').textContent = detail; $('confirm-action').textContent = title;
    confirmAction = callback; $('confirm-dialog').showModal();
  }
  async function loadHistory() {
    const params = new URLSearchParams({ hours: $('history-hours').value, service: $('history-service').value });
    $('export-history').href = `api/export.csv?${params}`;
    try {
      const response = await request(`api/history?${params}`);
      const rows = response.samples.flatMap(snapshot => snapshot.endpoints.map(row => ({ ...row, checked_at: snapshot.last_updated })));
      const green = rows.filter(row => row.status === 'Green').length;
      const average = rows.length ? rows.reduce((sum, row) => sum + row.latency_ms, 0) / rows.length : 0;
      $('history-summary').textContent = `${response.samples.length} saved snapshots · ${rows.length} service checks · ${green} operational results · average ${Math.round(average)}ms. Chart and table use the latest ${response.limit} snapshots in this range.`;
      $('history-rows').replaceChildren(...rows.slice(-30).reverse().map(row => {
        const tr = element('tr'); for (const value of [date(row.checked_at), row.name, row.observer_error ? 'Monitor blocked' : row.status === 'Red' && [401, 403].includes(row.status_code) ? 'Access denied' : { Green: 'Operational', Yellow: 'Degraded', Red: 'Outage' }[row.status], row.status_code ?? 'No response', `${Math.round(row.latency_ms)} ms`]) tr.append(element('td', value)); return tr;
      }));
      if (!rows.length) { empty($('history-chart'), 'No saved checks in this range.'); return; }
      const points = response.samples.filter(snapshot => snapshot.endpoints.length).map(snapshot => snapshot.endpoints.reduce((sum, row) => sum + row.latency_ms, 0) / snapshot.endpoints.length);
      const max = Math.max(1, ...points);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 800 160'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Average response time per saved snapshot, between zero and ${Math.ceil(max)} milliseconds.`); svg.classList.add('chart');
      const path = document.createElementNS(svg.namespaceURI, 'polyline'); path.setAttribute('points', points.map((value, index) => `${20 + index * 760 / Math.max(1, points.length - 1)},${140 - value / max * 120}`).join(' ')); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#79e3bb'); path.setAttribute('stroke-width', '3'); svg.append(path);
      $('history-chart').replaceChildren(element('p', `Average response time per snapshot · chart maximum ${Math.ceil(max)}ms`, 'muted small'), svg);
    } catch (_) { $('history-summary').textContent = 'History could not be loaded. Try again; current monitoring is shown separately.'; }
  }
  document.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.close) { $(target.dataset.close).close(); return; }
    if (target.dataset.view || target.dataset.openView) { showView(target.dataset.view || target.dataset.openView); return; }
    if (target.dataset.discard) { populateSettings(target.dataset.discard); return; }
    const { action: kind, id } = target.dataset;
    if (kind === 'edit-service') editService(id);
    if (kind === 'incident') editIncident(id);
    if (kind === 'history-service') { $('history-service').value = id; showView('history'); }
    if (kind === 'pause' || kind === 'resume') await action('api/service-action', { id, action: kind, revision: data.config.revision });
    if (kind === 'remove') confirm('Remove service', 'Stop monitoring this service? Its saved observations and incident notes remain. Open incidents are marked “Monitoring stopped,” not recovered.', () => action('api/service-action', { id, action: 'remove', revision: data.config.revision }));
    if (kind === 'replay') confirm('Retry failed notification', 'Start a new retry cycle using the same notification reference? Inspect the receiver first. A receiver that already accepted it should deduplicate this retry.', () => action('api/delivery/replay', { id }));
  });
  $('confirm-action').addEventListener('click', () => { $('confirm-dialog').close(); confirmAction?.(); confirmAction = null; });
  $('add-service').addEventListener('click', () => editService());
  $('check-now').addEventListener('click', () => action('api/check', {}));
  $('send-test').addEventListener('click', () => action('api/delivery/test', {}));
  $('retry-due').addEventListener('click', () => action('api/delivery/retry', {}));
  $('cancel-pending').addEventListener('click', () => confirm('Cancel pending deliveries', 'Stop retrying all pending notifications? They remain as failed records marked “Canceled by operator.”', () => action('api/delivery/cancel-pending', {})));
  $('apply-demo').addEventListener('click', () => action('api/demo', { scenario: $('demo-scenario').value }));
  $('apply-receiver').addEventListener('click', () => action('api/demo', { receiver: $('demo-receiver').value }));
  $('incident-filter').addEventListener('change', renderIncidents); $('delivery-filter').addEventListener('change', renderDeliveries);
  $('load-history').addEventListener('click', loadHistory);
  for (const id of ['settings-form', 'webhook-form']) $(id).addEventListener('input', () => { $(id).dataset.dirty = 'true'; });
  $('service-form').addEventListener('submit', async event => {
    event.preventDefault(); const codes = $('service-codes').value.split(',').map(value => Number(value.trim()));
    const payload = { revision: Number($('service-form').dataset.revision), id: $('service-id').value,
      name: $('service-name').value, url: $('service-url').value, timeout_seconds: Number($('service-timeout').value),
      degraded_after_ms: Number($('service-threshold').value), expected_statuses: codes, enabled: $('service-enabled').checked };
    if (await action('api/service-save', payload, $('service-form'))) $('service-dialog').close();
  });
  $('incident-form').addEventListener('submit', async event => {
    event.preventDefault(); if (await action('api/incident', { id: $('incident-id').value, acknowledge: $('incident-acknowledge').checked, note: $('incident-note').value }, $('incident-form'))) $('incident-dialog').close();
  });
  $('settings-form').addEventListener('submit', event => {
    event.preventDefault(); action('api/settings', { revision: Number($('settings-form').dataset.revision), interval_seconds: Number($('interval-seconds').value), retention_days: Number($('retention-days').value), monitoring_enabled: $('monitoring-enabled').checked }, $('settings-form'));
  });
  $('webhook-form').addEventListener('submit', event => {
    event.preventDefault(); action('api/webhook', { revision: Number($('webhook-form').dataset.revision), webhook_url: $('webhook-url').value, notifications_enabled: $('webhook-enabled').checked }, $('webhook-form'));
  });
  window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));
  showView(location.hash.slice(1), false);
  refresh().then(() => { message(data ? data.config.services.length ? 'Workspace ready.' : 'Ready to add your first service.' : 'Workspace unavailable.', !data); if (location.hash === '#history') loadHistory(); });
  setInterval(refresh, 5000);
  setInterval(() => { if (data) { const current = status(); if (current.kind !== renderedKind) render(); else { $('health-label').textContent = current.label; $('health-detail').textContent = current.detail; } } }, 1000);
})();
