(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let data = null, offline = false, refreshJob = null, actionBusy = false, confirmAction = null, renderedKind = null, historyRequest = 0;
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
      renderAvailability();
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
    $('check-now').textContent = data.runner.running ? 'Checking…' : 'Check now';
    $('onboarding').hidden = config.services.length > 0;
    $('onboarding-detail').textContent = config.monitoring_enabled ? `Add its name and URL. Sentinel checks it every ${config.interval_seconds} seconds and keeps the results here.` : 'Add its name and URL, then choose Check now. Scheduled checks are paused in Settings.';
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
    renderCards(trustworthy); renderServices(); renderIncidents(); renderDeliveries(); populateSettings(); renderAvailability();
    const historyValue = $('history-service').value;
    $('history-service').replaceChildren(element('option', 'All services'));
    $('history-service').firstChild.value = '';
    for (const row of config.services) { const option = element('option', row.name); option.value = row.id; $('history-service').append(option); }
    $('history-service').value = historyValue;
  }
  function renderAvailability() {
    if (!data) return;
    const config = data.config, pending = data.deliveries.filter(row => row.status === 'pending');
    const connected = !offline && !actionBusy;
    const configured = !!config.webhook_url, enabled = configured && config.notifications_enabled;
    const due = pending.filter(row => Date.parse(row.next_attempt_at) <= Date.now());
    const next = pending.length ? Math.min(...pending.map(row => Date.parse(row.next_attempt_at))) : null;
    const dirty = $('webhook-form').dataset.dirty === 'true';
    $('check-now').disabled = !connected || data.runner.running || !config.services.some(row => row.enabled);
    $('add-service').disabled = !connected || config.services.length >= 8;
    $('add-first-service').disabled = !connected;
    $('send-test').disabled = !connected || !enabled || dirty;
    $('retry-due').disabled = !connected || !enabled || !due.length || dirty;
    $('cancel-pending').disabled = !connected || !pending.length;
    for (const retry of document.querySelectorAll('button[data-action="replay"]')) retry.disabled = !connected || !enabled || dirty;
    $('receiver-step').classList.toggle('complete', configured);
    $('enable-step').classList.toggle('complete', enabled);
    $('receiver-step').textContent = configured ? 'Receiver URL saved' : 'Save a receiver URL';
    $('enable-step').textContent = enabled ? 'Delivery enabled' : 'Enable delivery';
    const reason = offline ? 'Reconnect to Sentinel before sending alerts.' : dirty ? 'Save or discard your receiver changes before sending a test or retrying messages.' : !configured ? 'Save your receiver URL and enable delivery to send a test.' : !enabled ? 'Enable delivery and save the receiver settings to send a test.' : 'Ready to send. Check Delivery history for the receiver’s response.';
    $('notification-guidance').textContent = reason;
    $('send-help').textContent = reason;
    $('retry-help').textContent = !pending.length ? 'No messages are waiting for retry.' : !enabled ? `${pending.length} waiting message${pending.length === 1 ? '' : 's'} retained. Enable delivery to resume retries.` : due.length ? `${due.length} message${due.length === 1 ? '' : 's'} ready for retry. Automatic retries also continue in the background.` : `Next automatic retry in ${Math.max(1, Math.ceil((next - Date.now()) / 1000))} seconds. The waiting time prevents repeated requests to a failing receiver.`;
    $('cancel-help').textContent = pending.length ? `Stop retries for ${pending.length} waiting message${pending.length === 1 ? '' : 's'}. A confirmation appears first.` : 'No waiting messages to cancel.';
  }
  function renderCards(trustworthy) {
    if (!data.config.services.length) { $('service-cards').replaceChildren(); return; }
    replace($('service-cards'), data.config.services.map(service => {
      const observed = data.snapshot.endpoints?.find(row => row.id === service.id && row.url === service.url);
      const card = element('article', undefined, 'service-card');
      const top = element('div', undefined, 'card-top'), heading = element('h3');
      const title = button(service.name, 'history-service', service.id, 'service-title'); title.title = `View saved checks for ${service.name}`;
      heading.append(title); top.append(heading);
      const label = !service.enabled ? 'Paused' : !observed ? 'Not checked' : !trustworthy ? 'Last observed' : observed.status === 'Red' && [401, 403].includes(observed.status_code) ? 'Access denied' : { Green: 'Operational', Yellow: 'Degraded', Red: 'Outage' }[observed.status];
      top.append(badge(label, trustworthy && service.enabled ? observed?.status : 'Unknown'));
      card.append(top, element('p', service.url, 'url'));
      const readings = element('div', undefined, 'readings'); readings.append(element('span', `HTTP ${observed?.status_code ?? '—'}`), element('span', observed ? `${Math.round(observed.latency_ms)} ms` : 'No observation'));
      card.append(readings); if (observed?.error) card.append(element('p', observed.error, 'muted small'));
      if (observed?.status === 'Red' && [401, 403].includes(observed.status_code)) card.append(element('p', 'This endpoint rejected the automated check. Inspect its access requirements.', 'muted small'));
      const actions = element('div', undefined, 'buttons card-actions'); actions.append(button('View history', 'history-service', service.id), button('Manage service', 'edit-service', service.id)); card.append(actions);
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
    if (!selected.length) { empty($('delivery-list'), filter === 'all' ? 'No deliveries yet. Connect a receiver above, then send a test notification.' : 'No deliveries match this filter. Choose All recent deliveries to see other results.'); return; }
    replace($('delivery-list'), selected.map(row => {
      const item = element('article', undefined, 'journal-row'); const heading = element('div', undefined, 'journal-heading');
      heading.append(element('h3', `${row.event.type[0].toUpperCase() + row.event.type.slice(1)} · ${row.event.name}`), badge(row.status === 'delivered' ? 'Acknowledged' : row.status === 'pending' ? 'Pending' : 'Failed', row.status));
      item.append(heading, element('p', `${row.total_attempts} total attempt${row.total_attempts === 1 ? '' : 's'} · ${row.attempts} of 5 attempts used${row.last_error ? ` · ${row.last_error}` : ''}`));
      item.append(element('p', row.status === 'pending' ? `Scheduled retry ${date(row.next_attempt_at)}` : row.status === 'delivered' ? `Acknowledged by receiver ${date(row.delivered_at)}` : 'Automatic retries stopped. Check the receiver before retrying.'));
      item.append(element('p', `Reference ${row.event.id}`, 'muted small'));
      if (row.status === 'failed' && row.replayable) { const buttons = element('div', undefined, 'buttons'), retry = button('Retry failed notification', 'replay', row.event.id); retry.disabled = offline || actionBusy || !data.config.notifications_enabled; buttons.append(retry); item.append(buttons); if (!data.config.notifications_enabled) item.append(element('p', 'Enable notification delivery before retrying this message.', 'muted small')); }
      else if (row.status === 'failed') item.append(element('p', 'Older saved record. It remains in history but can no longer be retried here.', 'muted small'));
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
    $('service-advanced').open = !!row && (row.timeout_seconds !== 5 || row.degraded_after_ms !== 1000 || row.expected_statuses.join(',') !== '200');
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
    const sequence = ++historyRequest;
    const params = new URLSearchParams({ hours: $('history-hours').value, service: $('history-service').value });
    $('export-history').removeAttribute('href'); $('export-history').setAttribute('aria-disabled', 'true');
    $('history-summary').textContent = 'Loading saved checks…'; $('load-history').disabled = true;
    try {
      const response = await request(`api/history?${params}`);
      if (sequence !== historyRequest) return;
      const rows = response.samples.flatMap(snapshot => snapshot.endpoints.map(row => ({ ...row, checked_at: snapshot.last_updated })));
      const green = rows.filter(row => row.status === 'Green').length;
      const replied = rows.filter(row => row.status_code !== null && !row.observer_error);
      const average = replied.length ? `${Math.round(replied.reduce((sum, row) => sum + row.latency_ms, 0) / replied.length)} ms average HTTP response` : 'No HTTP replies';
      $('history-summary').textContent = `${rows.length} service checks · ${green} operational results · ${average}. Showing up to ${response.limit} saved check times; the table lists the latest 30 results.`;
      $('export-history').href = `api/export.csv?${params}`; $('export-history').removeAttribute('aria-disabled');
      $('history-rows').replaceChildren(...rows.slice(-30).reverse().map(row => {
        const tr = element('tr'); for (const value of [date(row.checked_at), row.name, row.observer_error ? 'Monitor blocked' : row.status === 'Red' && [401, 403].includes(row.status_code) ? 'Access denied' : { Green: 'Operational', Yellow: 'Degraded', Red: 'Outage' }[row.status], row.status_code ?? 'No response', `${Math.round(row.latency_ms)} ms`]) tr.append(element('td', value)); return tr;
      }));
      renderChart(response.samples.filter(snapshot => snapshot.endpoints.length));
    } catch (_) {
      if (sequence !== historyRequest) return;
      $('history-summary').textContent = 'History could not be loaded. Choose Load history to retry. Current monitoring is shown separately.';
      $('history-rows').replaceChildren(); empty($('history-chart'), 'Saved checks are unavailable.');
    } finally { if (sequence === historyRequest) $('load-history').disabled = false; }
  }
  function renderChart(samples) {
    if (!samples.length) { empty($('history-chart'), 'No saved checks in this range. Try a longer time range or run a check.'); return; }
    const points = samples.map(snapshot => {
      const replied = snapshot.endpoints.filter(row => row.status_code !== null && !row.observer_error);
      return { time: snapshot.last_updated, value: replied.length ? replied.reduce((sum, row) => sum + row.latency_ms, 0) / replied.length : null, replies: replied.length, total: snapshot.endpoints.length };
    });
    const max = Math.max(100, Math.ceil(Math.max(0, ...points.map(row => row.value || 0)) / 100) * 100);
    const area = element('div', undefined, 'chart-area'), ticks = element('div', undefined, 'chart-y');
    for (const value of [max, max / 2, 0]) ticks.append(element('span', `${value} ms`));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 760 180'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `HTTP response time history, from zero to ${max} milliseconds. Use the recorded check slider below for exact times and values.`); svg.classList.add('chart');
    function shape(tag, attributes) { const node = document.createElementNS(svg.namespaceURI, tag); for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value); svg.append(node); return node; }
    for (const y of [4, 90, 176]) shape('line', { x1: 0, x2: 760, y1: y, y2: y, stroke: '#405369', 'stroke-dasharray': '4 5', 'vector-effect': 'non-scaling-stroke' });
    const times = points.map(row => Date.parse(row.time)), first = times[0], span = times.at(-1) - first;
    const x = index => span ? 4 + (times[index] - first) * 752 / span : 380, y = value => 176 - value / max * 172;
    let segment = false;
    const path = points.map((row, index) => { if (row.value === null) { segment = false; return ''; } const command = `${segment ? 'L' : 'M'}${x(index)},${y(row.value)}`; segment = true; return command; }).join(' ');
    shape('path', { d: path, fill: 'none', stroke: '#79e3bb', 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke' });
    const marker = shape('line', { x1: 0, x2: 0, y1: 0, y2: 180, stroke: '#b5d4ff', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
    const dot = shape('circle', { cx: 0, cy: 0, r: 4, fill: '#b5d4ff' });
    const axes = element('div', undefined, 'chart-x'), shortDate = time => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    for (const time of [first, first + span / 2, times.at(-1)]) axes.append(element('span', shortDate(time)));
    area.append(ticks, svg, axes);
    const description = element('p', 'Average HTTP response time at each saved check. Checks without an HTTP reply appear as gaps. Times use your browser’s local timezone.', 'muted small');
    const label = element('label', 'Inspect a recorded check'), slider = element('input');
    slider.type = 'range'; slider.min = 0; slider.max = points.length - 1; slider.step = 1; slider.value = points.length - 1; slider.id = 'chart-sample'; slider.className = 'chart-inspector';
    const reading = element('p', undefined, 'chart-reading'); reading.id = 'chart-reading'; reading.setAttribute('role', 'status'); slider.setAttribute('aria-describedby', 'chart-reading'); label.append(slider);
    let selected = -1;
    function inspect(index) {
      index = Math.max(0, Math.min(points.length - 1, index)); if (selected === index) return; selected = index;
      const row = points[index]; slider.value = index; slider.setAttribute('aria-valuetext', `Check ${index + 1} of ${points.length}, ${date(row.time)}, ${row.value === null ? 'no HTTP reply' : `${Math.round(row.value)} milliseconds`}`);
      marker.setAttribute('x1', x(index)); marker.setAttribute('x2', x(index));
      dot.setAttribute('cx', x(index)); dot.setAttribute('cy', row.value === null ? 0 : y(row.value)); dot.style.display = row.value === null ? 'none' : '';
      reading.textContent = `${new Date(row.time).toLocaleString()} · ${row.value === null ? 'No HTTP reply; response time unavailable' : `${Math.round(row.value)} ms average response`} · ${row.replies} of ${row.total} check${row.total === 1 ? '' : 's'} received an HTTP reply.`;
    }
    slider.addEventListener('input', () => inspect(Number(slider.value)));
    function pointer(event) {
      const bounds = svg.getBoundingClientRect(), time = first + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * span;
      inspect(times.reduce((nearest, value, index) => Math.abs(value - time) < Math.abs(times[nearest] - time) ? index : nearest, 0));
    }
    svg.addEventListener('pointermove', event => { if (event.pointerType === 'mouse') pointer(event); }); svg.addEventListener('pointerdown', pointer);
    $('history-chart').replaceChildren(element('h3', 'Response time over time'), description, area, label, reading); inspect(points.length - 1);
  }
  document.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.close) { $(target.dataset.close).close(); return; }
    if (target.dataset.view || target.dataset.openView) {
      if (target.dataset.incidentFilter) { $('incident-filter').value = target.dataset.incidentFilter; renderIncidents(); }
      if (target.dataset.deliveryFilter) { $('delivery-filter').value = target.dataset.deliveryFilter; renderDeliveries(); }
      showView(target.dataset.view || target.dataset.openView); return;
    }
    if (target.dataset.discard) { populateSettings(target.dataset.discard); renderAvailability(); return; }
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
  $('add-first-service').addEventListener('click', () => editService());
  $('check-now').addEventListener('click', () => action('api/check', {}));
  $('send-test').addEventListener('click', () => action('api/delivery/test', {}));
  $('retry-due').addEventListener('click', () => action('api/delivery/retry', {}));
  $('cancel-pending').addEventListener('click', () => confirm('Cancel pending deliveries', 'Stop retrying all pending notifications? They remain as failed records marked “Canceled by operator.”', () => action('api/delivery/cancel-pending', {})));
  $('apply-demo').addEventListener('click', () => action('api/demo', { scenario: $('demo-scenario').value }));
  $('apply-receiver').addEventListener('click', () => action('api/demo', { receiver: $('demo-receiver').value }));
  $('incident-filter').addEventListener('change', renderIncidents); $('delivery-filter').addEventListener('change', renderDeliveries);
  $('load-history').addEventListener('click', loadHistory);
  $('export-history').setAttribute('role', 'link');
  for (const id of ['history-service', 'history-hours']) $(id).addEventListener('change', loadHistory);
  for (const id of ['settings-form', 'webhook-form']) $(id).addEventListener('input', () => { $(id).dataset.dirty = 'true'; renderAvailability(); });
  $('service-form').addEventListener('invalid', event => { if ($('service-advanced').contains(event.target)) $('service-advanced').open = true; }, true);
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
  setInterval(() => { if (data) { const current = status(); if (current.kind !== renderedKind) render(); else { $('health-label').textContent = current.label; $('health-detail').textContent = current.detail; renderAvailability(); } } }, 1000);
})();
