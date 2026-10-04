const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const status = page => page.locator('#global-status-text');
const apiCard = page => page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Orders API', exact: true }) }).first();

test.beforeEach(async ({ page, request }) => {
  await request.post('/api/scenario', { data: { scenario: 'healthy' } });
  await page.goto('/');
  await expect(status(page)).toHaveText('All services operational');
  await expect(page.locator('.card')).toHaveCount(4);
});

test('outage, stale monitoring, and recovery preserve the timeline', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'API outage', exact: true }).click();
  await expect(status(page)).toHaveText('Service outage detected');
  await expect(apiCard(page)).toHaveAttribute('data-status', 'Red');
  await expect(apiCard(page)).toContainText('503');
  await expect(page.locator('#incidents-list .active')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('outage.png'), fullPage: true });
  await page.getByRole('button', { name: 'Pause telemetry', exact: true }).click();
  await expect(status(page)).toHaveText('Telemetry is stale');
  await expect(page.locator('.card[data-status="Unknown"]')).toHaveCount(4);
  await expect(page.locator('#healthy-count')).toHaveText('—');
  await expect(page.locator('#notice')).toContainText('Service health is unknown');
  await page.screenshot({ path: testInfo.outputPath('stale.png'), fullPage: true });
  await page.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect(status(page)).toHaveText('All services operational');
  await expect(page.locator('#incidents-list .active')).toHaveCount(0);
  await expect(page.locator('#incidents-list .resolved')).not.toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('recovery.png'), fullPage: true });
});

test('slow responses and unavailable telemetry do not show current healthy counts', async ({ page }) => {
  await page.getByRole('button', { name: 'Slow response', exact: true }).click();
  await expect(status(page)).toHaveText('Service response degraded');
  await expect(apiCard(page)).toHaveAttribute('data-status', 'Yellow');
  await page.route('**/status_data.json', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(status(page)).toHaveText('Telemetry unavailable');
  await expect(page.locator('.card[data-status="Unknown"]')).toHaveCount(4);
  await expect(page.locator('#healthy-count')).toHaveText('—');
  await page.unroute('**/status_data.json');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(status(page)).toHaveText('Service response degraded');
});

test('layout fits the viewport in healthy, outage, and stale states', async ({ page }, testInfo) => {
  for (const scenario of ['healthy', 'outage', 'stale']) {
    await page.getByRole('button', { name: { healthy: 'Healthy', outage: 'API outage', stale: 'Pause telemetry' }[scenario], exact: true }).click();
    await expect(page.locator(`[data-scenario="${scenario}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`layout-${scenario}.png`), fullPage: true });
  }
});

test('WCAG A/AA automated checks pass across operational states', async ({ page }, testInfo) => {
  for (const scenario of ['healthy', 'outage', 'stale', 'recovered']) {
    await page.getByRole('button', { name: { healthy: 'Healthy', outage: 'API outage', stale: 'Pause telemetry', recovered: 'Recover' }[scenario], exact: true }).click();
    await expect(page.locator(`[data-scenario="${scenario}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`[data-scenario="${scenario}"]`)).toBeEnabled();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    await testInfo.attach(`accessibility-${scenario}`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(results.violations).toEqual([]);
  }
});

test('keyboard navigation reaches the main content and retains control focus', async ({ page }) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to service health' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.getByRole('button', { name: 'API outage', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveText('Service outage detected');
  await expect(page.getByRole('button', { name: 'API outage', exact: true })).toBeFocused();
});

test('optional malformed history does not hide valid current service health', async ({ page }) => {
  for (const history of [null, { schema_version: 1, samples: [null] }, { schema_version: 1, samples: [{ timestamp: new Date().toISOString(), endpoints: [null] }] }]) {
    await page.route('**/history.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(history) }));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(status(page)).toHaveText('All services operational');
    await expect(page.locator('#healthy-count')).toHaveText('4');
    await expect(page.locator('.history-caption')).toHaveText(Array(4).fill('History unavailable'));
    await page.unroute('**/history.json');
  }
});

test('a partial history write cannot display checks newer than the completed snapshot', async ({ page }) => {
  const response = await page.request.get('/status_data.json');
  const snapshot = await response.json();
  const sample = timestamp => ({ timestamp, endpoints: snapshot.endpoints.map(row => ({ id: row.id, status: row.status, latency_ms: row.latency_ms, status_code: row.status_code })) });
  const current = sample(snapshot.last_updated);
  const future = sample(new Date(Date.parse(snapshot.last_updated) + 60000).toISOString());
  await page.route('**/status_data.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) }));
  await page.route('**/history.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schema_version: 1, samples: [current, future] }) }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(status(page)).toHaveText('All services operational');
  await expect(page.locator('.history-caption')).toHaveText(Array(4).fill('1/1 recent checks operational'));
  await expect(page.locator('.sample-history span')).toHaveCount(4);
});
