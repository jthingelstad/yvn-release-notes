// Browser tests for sign-up, against tools/dev-server.ts and its
// in-memory fakes: no AWS, no real mail, nothing live. Optional, unlike
// `validate`: run them with `npm run e2e` (AGENTS.md, "Operating")
// or the `e2e` workflow.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.YVN_E2E_PORT ?? 8790);

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  // Ada and MCP suites share one fictional inbox: their newest codes replace
  // each other, so test files must not race that address. Native load tests
  // separately prove request concurrency without a shared sign-in race.
  workers: 1,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Headless Chrome lays out no narrower than about 500px.
    viewport: { width: 520, height: 1000 },
    timezoneId: 'America/Chicago',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 520, height: 1000 },
        // A made-up microphone (a tone) for the Record button, allowed without asking.
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
        permissions: ['microphone']
      }
    }
  ],
  webServer: {
    command: `node --import tsx tools/dev-server.ts --port ${PORT} --fake-places --fake-links`,
    cwd: '..',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    // The request log; Playwright says if the server doesn't start.
    stdout: 'ignore',
    stderr: 'ignore'
  }
});
