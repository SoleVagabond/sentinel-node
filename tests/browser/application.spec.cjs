const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs/promises');

async function state(request, root = '') { return (await request.get(`${root}/api/state`)).json(); }
async function post(request, route, payload, root = '') {
  const current = await state(request, root);
  return request.post(`${root}/api/${route}`, { data: payload, headers: { 'X-Sentinel-CSRF': current.csrf } });
}
async function checked(page) {
  await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#action-message')).toHaveText('Check completed. Results are saved.');
}
const serviceRow = (page, name) => page.locator('#services-list article').filter({ has: page.getByRole('heading', { name, exact: true }) });

test.beforeEach(async ({ page, request }) => {
  let current = await state(request);
  for (const row of current.config.services) {
    if (!['api', 'worker'].includes(row.id)) {
      await post(request, 'service-action', { revision: (await state(request)).config.revision, id: row.id, action: 'remove' });
    } else if (!row.enabled) {
      await post(request, 'service-action', { revision: (await state(request)).config.revision, id: row.id, action: 'resume' });
    }
  }
  await post(request, 'demo', { scenario: 'healthy', receiver: 'available' });
  current = await state(request);
  await post(request, 'settings', { revision: current.config.revision, interval_seconds: 3600, retention_days: 7, monitoring_enabled: true });
  current = await state(request);
  await post(request, 'webhook', { revision: current.config.revision, webhook_url: current.config.webhook_url, notifications_enabled: true });
  await expect.poll(async () => (await post(request, 'check', {})).ok()).toBe(true);
  await expect.poll(async () => {
    await post(request, 'delivery/retry', {});
    return (await state(request)).deliveries.filter(row => row.status === 'pending').length;
  }).toBe(0);
  await page.goto('/');
  await expect(page.locator('#health-label')).toHaveText('Checked services operational');
});

test('freshness expiry hides current health before the next state fetch', async ({ page, request }) => {
  const current = await state(request);
  const start = new Date();
  current.config.interval_seconds = 5;
  current.snapshot.last_updated = start.toISOString();
  await page.clock.install({ time: start });
  await page.route('**/api/state', route => route.fulfill({ json: current }));
  await page.goto('/');
  await expect(page.locator('#health-label')).toHaveText('Checked services operational');
  await page.clock.pauseAt(new Date(start.getTime() + 14000));
  await page.clock.runFor(2000);
  await expect(page.locator('#health-label')).toHaveText('Monitoring is stale');
  await expect(page.locator('#operational-total')).toHaveText('—');
  await expect(page.locator('#service-cards')).toContainText('Last observed');
  await expect(page.locator('#service-cards .badge.Green')).toHaveCount(0);
});

test('blocked monitor access and HTTP forbidden responses have distinct explanations', async ({ page, request }) => {
  const current = await state(request);
  for (const row of current.snapshot.endpoints) Object.assign(row, { status: 'Red', status_code: null, observer_error: true, error: 'Monitor network access blocked by the operating system' });
  current.runner.error = 'Monitor network access blocked by the operating system';
  current.incidents = [];
  await page.route('**/api/state', route => route.fulfill({ json: current }));
  await page.goto('/');
  await expect(page.locator('#health-label')).toHaveText('Monitor needs attention');
  await expect(page.locator('#operational-total')).toHaveText('—');
  await expect(page.locator('#service-cards .badge.Red')).toHaveCount(0);
  current.runner.error = null;
  for (const row of current.snapshot.endpoints) Object.assign(row, { status_code: 403, observer_error: false, error: 'Unexpected HTTP 403' });
  await page.reload();
  await expect(page.locator('#health-label')).toHaveText('Service access denied');
  await expect(page.locator('#service-cards')).toContainText('Access denied');
  await expect(page.locator('#health-detail')).toContainText('block automated clients');
});

test('service setup, edit, pause, resume, removal, and history work through the interface', async ({ page }) => {
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await page.getByRole('button', { name: 'Add service', exact: true }).click();
  await page.getByRole('textbox', { name: 'Service name', exact: true }).fill('Shipping worker');
  await page.getByRole('textbox', { name: 'Website URL', exact: true }).fill('http://127.0.0.1:8793/fixtures/worker');
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await expect(serviceRow(page, 'Shipping worker')).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await serviceRow(page, 'Shipping worker').getByRole('button', { name: 'Edit service', exact: true }).click();
  await page.getByRole('textbox', { name: 'Service name', exact: true }).fill('Dispatch worker');
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await expect(serviceRow(page, 'Dispatch worker')).toBeVisible();
  await serviceRow(page, 'Dispatch worker').getByRole('button', { name: 'Pause service', exact: true }).click();
  await expect(serviceRow(page, 'Dispatch worker')).toContainText('Paused');
  await serviceRow(page, 'Dispatch worker').getByRole('button', { name: 'Resume service', exact: true }).click();
  await expect(serviceRow(page, 'Dispatch worker')).toContainText('Enabled');
  await checked(page);
  await serviceRow(page, 'Dispatch worker').getByRole('button', { name: 'View history', exact: true }).click();
  await expect(page.locator('#history-summary')).toContainText('service checks');
  await expect(page.locator('#history-rows')).toContainText('Dispatch worker');
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await serviceRow(page, 'Dispatch worker').getByRole('button', { name: 'Remove service', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove service', exact: true }).click();
  await expect(serviceRow(page, 'Dispatch worker')).toHaveCount(0);
});

test('incident response retains notes through recovery and reload', async ({ page }, testInfo) => {
  await page.getByRole('combobox', { name: 'Service behavior', exact: true }).selectOption('outage');
  await page.getByRole('button', { name: 'Apply service behavior', exact: true }).click();
  await expect(page.locator('#action-message')).toContainText('Local fixture updated');
  await checked(page);
  await expect(page.locator('#health-label')).toHaveText('Service outage detected');
  await page.getByRole('button', { name: 'Incidents', exact: true }).click();
  await page.locator('#incident-list article').first().getByRole('button', { name: 'Respond to incident', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Acknowledge this incident', exact: true }).check();
  await page.getByRole('textbox', { name: 'Investigation note', exact: true }).fill('Reviewed service logs; waiting for recovery.');
  await page.getByRole('button', { name: 'Save incident response', exact: true }).click();
  await expect(page.locator('#incident-list article').first()).toContainText('Acknowledged');
  await expect(page.locator('#incident-list article').first()).toContainText('Open');
  await page.getByRole('combobox', { name: 'Service behavior', exact: true }).selectOption('healthy');
  await page.getByRole('button', { name: 'Apply service behavior', exact: true }).click();
  await checked(page);
  await expect(page.locator('#incident-list article').first()).toContainText('Recovered');
  await page.reload();
  await expect(page.locator('#incident-list article').first()).toContainText('Reviewed service logs; waiting for recovery.');
  await page.screenshot({ path: testInfo.outputPath('incident-response.png'), fullPage: true });
});

test('lost reply, cancel, and deliberate failed-delivery retry retain receiver identity', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('combobox', { name: 'Receiver behavior', exact: true }).selectOption('lose-next-response');
  await page.getByRole('button', { name: 'Apply receiver behavior', exact: true }).click();
  await expect(page.locator('#action-message')).toContainText('Local fixture updated');
  await page.getByRole('button', { name: 'Send test notification', exact: true }).click();
  await expect(page.locator('#action-message')).toContainText('Test saved in the delivery queue');
  const initial = await state(request);
  const lostId = initial.deliveries[0].event.id;
  await expect.poll(async () => {
    await post(request, 'delivery/retry', {});
    return (await state(request)).deliveries.find(row => row.event.id === lostId).status;
  }).toBe('delivered');
  const receiptData = await (await request.get('/api/demo-receipts')).json();
  expect(receiptData.items.filter(row => row.event.id === lostId)).toHaveLength(1);
  expect(receiptData.items.find(row => row.event.id === lostId).requests).toBe(2);
  await page.getByRole('combobox', { name: 'Receiver behavior', exact: true }).selectOption('unavailable');
  await page.getByRole('button', { name: 'Apply receiver behavior', exact: true }).click();
  await expect(page.locator('#action-message')).toContainText('Local fixture updated');
  await page.getByRole('button', { name: 'Send test notification', exact: true }).click();
  await expect(page.locator('#action-message')).toContainText('Test saved in the delivery queue');
  const canceledId = (await state(request)).deliveries[0].event.id;
  await page.getByRole('button', { name: 'Cancel pending deliveries', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel pending deliveries', exact: true }).click();
  await expect(page.locator('#action-message')).toContainText('Pending deliveries canceled');
  await page.getByRole('combobox', { name: 'Receiver behavior', exact: true }).selectOption('available');
  await page.getByRole('button', { name: 'Apply receiver behavior', exact: true }).click();
  await expect(page.locator('#action-message')).toContainText('Local fixture updated');
  const canceled = page.locator('#delivery-list article').filter({ hasText: canceledId });
  await canceled.getByRole('button', { name: 'Retry failed notification', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Retry failed notification', exact: true }).click();
  await expect(canceled).toContainText('Acknowledged');
  const final = (await state(request)).deliveries.find(row => row.event.id === canceledId);
  expect(final.manual_retries).toBe(1);
  expect(final.total_attempts).toBeGreaterThanOrEqual(2);
});

test('settings persist, backups download, and history exports recorded observations', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Run scheduled checks', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save monitoring settings', exact: true }).click();
  await expect(page.locator('#action-message')).toHaveText('Settings saved.');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.locator('#health-label')).toHaveText('Scheduled checks paused');
  await checked(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const backupDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download database backup', exact: true }).click();
  const backup = await backupDownload;
  const path = testInfo.outputPath('sentinel-backup.db');
  await backup.saveAs(path);
  expect((await fs.readFile(path)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('combobox', { name: 'Service', exact: true }).selectOption('api');
  await page.getByRole('button', { name: 'Load history', exact: true }).click();
  await expect(page.locator('#history-rows')).toContainText('Orders API');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export observations CSV', exact: true }).click();
  const download = await downloadEvent;
  const csvPath = testInfo.outputPath('observations.csv');
  await download.saveAs(csvPath);
  expect(await fs.readFile(csvPath, 'utf8')).toContain('Orders API');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
});

test('keyboard, accessible forms, and layouts work across every workspace', async ({ page }, testInfo) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to workspace', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  for (const view of ['Overview', 'Services', 'Incidents', 'Notifications', 'History', 'Settings']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
    if (view === 'History' && testInfo.project.use.viewport.width < 600) {
      const table = page.getByRole('region', { name: 'Saved observation table', exact: true });
      await table.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => table.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    }
  }
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await page.getByRole('button', { name: 'Add service', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Service name', exact: true })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add service', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('operator-workspace.png'), fullPage: true });
});

test('live mode starts empty and configures a real loopback service without demo controls', async ({ page }) => {
  await page.goto('http://127.0.0.1:8794/');
  await expect(page.locator('#demo-banner')).toBeHidden();
  await expect(page.locator('#health-label')).toHaveText('Add your first service');
  await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeDisabled();
  await expect(page.locator('#onboarding')).toBeVisible();
  await page.getByRole('button', { name: 'Add your first service', exact: true }).click();
  await expect(page.locator('#service-advanced')).not.toHaveAttribute('open');
  await page.getByRole('textbox', { name: 'Service name', exact: true }).fill('Owned verification endpoint');
  await page.getByRole('textbox', { name: 'Website URL', exact: true }).fill('http://127.0.0.1:8793/fixtures/worker');
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await expect(serviceRow(page, 'Owned verification endpoint')).toBeVisible();
  await checked(page);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.locator('#health-label')).toHaveText('Checked services operational');
  await expect(page.locator('#service-cards')).toContainText('HTTP 200');
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await serviceRow(page, 'Owned verification endpoint').getByRole('button', { name: 'Remove service', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove service', exact: true }).click();
  await expect(serviceRow(page, 'Owned verification endpoint')).toHaveCount(0);
});

test('advanced check settings are optional and custom values survive edit and polling', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await page.getByRole('button', { name: 'Add service', exact: true }).click();
  await expect(page.locator('#service-advanced')).not.toHaveAttribute('open');
  await page.getByRole('textbox', { name: 'Service name', exact: true }).fill('Custom checks');
  await page.getByRole('textbox', { name: 'Website URL', exact: true }).fill('http://127.0.0.1:8793/fixtures/worker');
  await page.locator('#service-advanced summary').click();
  await page.getByRole('spinbutton', { name: 'Timeout in seconds', exact: true }).fill('8');
  await page.getByRole('spinbutton', { name: 'Slow response threshold in ms', exact: true }).fill('2000');
  await page.getByRole('textbox', { name: 'Expected HTTP codes', exact: true }).fill('200, 204');
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  const row = serviceRow(page, 'Custom checks');
  await expect(row).toContainText('timeout 8s');
  await row.getByRole('button', { name: 'Edit service', exact: true }).click();
  await expect(page.locator('#service-advanced')).toHaveAttribute('open', '');
  await expect(page.getByRole('spinbutton', { name: 'Timeout in seconds', exact: true })).toHaveValue('8');
  await page.getByRole('textbox', { name: 'Service name', exact: true }).fill('Unsaved custom draft');
  await page.waitForResponse(response => response.url().endsWith('/api/state'));
  await expect(page.getByRole('textbox', { name: 'Service name', exact: true })).toHaveValue('Unsaved custom draft');
  await expect(page.getByRole('spinbutton', { name: 'Timeout in seconds', exact: true })).toHaveValue('8');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  const saved = (await state(request)).config.services.find(item => item.name === 'Custom checks');
  expect(saved.expected_statuses).toEqual([200, 204]);
});

test('notification actions explain paused settings and unsaved drafts', async ({ page }) => {
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send test notification', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry due deliveries', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel pending deliveries', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Enable notification delivery', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Send test notification', exact: true })).toBeDisabled();
  await expect(page.locator('#notification-guidance')).toContainText('Save or discard');
  await page.getByRole('button', { name: 'Save receiver settings', exact: true }).click();
  await expect(page.locator('#notification-guidance')).toContainText('Enable delivery');
  await page.getByRole('checkbox', { name: 'Enable notification delivery', exact: true }).check();
  await page.locator('#webhook-form').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Enable notification delivery', exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Send test notification', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Enable notification delivery', exact: true }).check();
  await page.getByRole('button', { name: 'Save receiver settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send test notification', exact: true })).toBeEnabled();
});

test('retry countdown enables only eligible messages and still allows cancellation', async ({ page, request }) => {
  await post(request, 'demo', { receiver: 'unavailable' });
  await post(request, 'delivery/test', {});
  const current = await state(request), time = new Date();
  const pending = current.deliveries.find(row => row.status === 'pending');
  expect(pending).toBeTruthy();
  pending.next_attempt_at = new Date(time.getTime() + 60000).toISOString();
  await page.clock.install({ time });
  await page.route('**/api/state', route => route.fulfill({ json: current }));
  // Freeze before navigation, with a future target that permits setup time.
  await page.clock.pauseAt(new Date(time.getTime() + 10000));
  await page.goto('/#notifications');
  await expect(page.getByRole('button', { name: 'Retry due deliveries', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel pending deliveries', exact: true })).toBeEnabled();
  await expect(page.locator('#retry-help')).toContainText('Next automatic retry');
  await page.clock.runFor(50000);
  await expect(page.getByRole('button', { name: 'Retry due deliveries', exact: true })).toBeEnabled();
  await expect(page.locator('#retry-help')).toContainText('ready for retry');
});

test('overview shortcuts, automatic history filters, and keyboard chart inspection work', async ({ page }) => {
  await page.getByRole('button', { name: /^Open incidents \d+ Investigate/ }).click();
  await expect(page.getByRole('combobox', { name: 'Show incidents', exact: true })).toHaveValue('open');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: /^Pending deliveries \d+ View waiting messages/ }).click();
  await expect(page.getByRole('combobox', { name: 'Show deliveries', exact: true })).toHaveValue('pending');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Orders API', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Service', exact: true })).toHaveValue('api');
  await expect(page.locator('#history-rows')).toContainText('Orders API');
  const slider = page.getByRole('slider', { name: 'Inspect a recorded check', exact: true });
  await slider.focus(); await page.keyboard.press('Home');
  await expect(slider).toHaveValue('0');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('1');
  await expect(page.locator('#chart-reading')).toContainText('received an HTTP reply');
  await expect(page.locator('.chart-x span')).toHaveCount(3);
  await expect(page.locator('.chart-y')).toContainText('ms');
  await page.getByRole('combobox', { name: 'Service', exact: true }).selectOption('worker');
  await expect(page.locator('#history-rows')).toContainText('Worker health');
  await expect(page.locator('#history-rows')).not.toContainText('Orders API');
  await expect(page.getByRole('link', { name: 'Export observations CSV', exact: true })).toHaveAttribute('href', /service=worker/);
});

test('chart gaps and rapid filters never present an old service as the new result', async ({ page }) => {
  let releaseOld;
  const held = new Promise(resolve => { releaseOld = resolve; });
  const start = Date.now() - 300000;
  const sample = (offset, latency, code) => ({ last_updated: new Date(start + offset).toISOString(), endpoints: [{ name: 'Worker health', id: 'worker', status: code === null ? 'Red' : 'Green', status_code: code, latency_ms: latency, observer_error: false }] });
  const worker = { limit: 500, samples: [sample(0, 100, 200), sample(10000, 0, null), sample(120000, 300, 200)] };
  await page.route('**/api/history?*', async route => {
    if (new URL(route.request().url()).searchParams.get('service') === 'api') {
      await held;
      await route.fulfill({ json: { limit: 500, samples: [{ ...sample(0, 99, 200), endpoints: [{ ...sample(0, 99, 200).endpoints[0], name: 'Orders API', id: 'api' }] }] } });
    } else await route.fulfill({ json: worker });
  });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('#chart-reading')).toContainText('300 ms');
  const oldRequest = page.waitForRequest(request => request.url().includes('api/history?') && new URL(request.url()).searchParams.get('service') === 'api');
  await page.getByRole('combobox', { name: 'Service', exact: true }).selectOption('api');
  await oldRequest;
  await expect(page.getByRole('link', { name: 'Export observations CSV', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('combobox', { name: 'Service', exact: true }).selectOption('worker');
  await expect(page.locator('#history-rows')).toContainText('Worker health');
  const finishedOld = page.waitForResponse(response => response.url().includes('api/history?') && new URL(response.url()).searchParams.get('service') === 'api');
  releaseOld(); await finishedOld;
  await expect(page.locator('#history-rows')).not.toContainText('Orders API');
  await expect(page.getByRole('link', { name: 'Export observations CSV', exact: true })).toHaveAttribute('href', /service=worker/);
  const slider = page.getByRole('slider', { name: 'Inspect a recorded check', exact: true });
  await slider.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#chart-reading')).toContainText('No HTTP reply; response time unavailable');
  await expect(page.locator('#history-summary')).toContainText('200 ms average HTTP response');
  await expect(page.locator('.chart path')).toHaveAttribute('d', /^M[^M]+M/);
});
