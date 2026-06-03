import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5175',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command:
      'DATABASE_URL=${DATABASE_URL:-postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test} PORT=5175 PUBLIC_SITE_URL=http://127.0.0.1:5175 NODE_ENV=test EMAIL_MODE=log TELEGRAM_NOTIFY_MODE=log WEBINAR_TEST_ROOM_MODE=off npx tsx src/server.ts',
    url: 'http://127.0.0.1:5175/crisis_premium/index.html',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
