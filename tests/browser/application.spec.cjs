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

test('service setup, edit, pause, resume, removal, and history work through the interface', async ({ page }) => {
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await page.getByRole('button', { name: 'Add service', exact: true }).click();
  await page.getByRole('textbox', { name: 'Service name', exact: true }).fill('Shipping worker');
  await page.getByRole('textbox', { name: 'HTTP URL', exact: true }).fill('http://127.0.0.1:8793/fixtures/worker');
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
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await page.getByRole('button', { name: 'Add service', exact: true }).click();
  await page.getByRole('textbox', { name: 'Service name', exact: true }).fill('Owned verification endpoint');
  await page.getByRole('textbox', { name: 'HTTP URL', exact: true }).fill('http://127.0.0.1:8793/fixtures/worker');
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
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
