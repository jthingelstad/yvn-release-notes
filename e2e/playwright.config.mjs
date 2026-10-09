// Browser tests for sign-up, against scripts/dev_server.py and its
// in-memory fakes: no AWS, no real mail, nothing live. Optional, unlike
// `validate`: run them with `npm run e2e` (AGENTS.md, "Operating")
// or the `e2e` workflow.
import { defineConfig, devices } from '@playwright/test';

const PORT = 8790;

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Headless Chrome lays out no narrower than about 500px.
    viewport: { width: 520, height: 1000 },
    timezoneId: 'America/Chicago',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 520, height: 1000 } } }],
  webServer: {
    command: `python3 scripts/dev_server.py --port ${PORT} --fake-places --fake-links`,
    cwd: '..',
    env: { PYTHONPATH: 'src' },
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    // The request log; Playwright says if the server doesn't start.
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
