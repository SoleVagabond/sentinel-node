const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'work/browser-report' }]],
  outputDir: 'work/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:8792',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'desktop', testMatch: 'release.spec.cjs', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-375', testMatch: 'release.spec.cjs', use: { browserName: 'chromium', viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    { name: 'mobile-320', testMatch: 'release.spec.cjs', use: { browserName: 'chromium', viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true } },
    { name: 'app-desktop', testMatch: 'application.spec.cjs', use: { baseURL: 'http://127.0.0.1:8793', browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'app-mobile-375', testMatch: 'application.spec.cjs', use: { baseURL: 'http://127.0.0.1:8793', browserName: 'chromium', viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    { name: 'app-mobile-320', testMatch: 'application.spec.cjs', use: { baseURL: 'http://127.0.0.1:8793', browserName: 'chromium', viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true } }
  ],
  webServer: [{
    command: `${process.env.PYTHON || 'python'} scripts/demo.py --port 8792`,
    url: 'http://127.0.0.1:8792/status_data.json',
    reuseExistingServer: false,
    timeout: 20000
  }, {
    command: `${process.env.PYTHON || 'python'} scripts/run_app.py --demo --port 8793 --interval 3600 --state-dir work/application-browser`,
    url: 'http://127.0.0.1:8793/api/state', reuseExistingServer: false, timeout: 20000
  }, {
    command: `${process.env.PYTHON || 'python'} scripts/run_app.py --port 8794 --interval 3600 --state-dir work/application-live-browser`,
    url: 'http://127.0.0.1:8794/api/state', reuseExistingServer: false, timeout: 20000
  }]
});
