import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultE2eDatabaseUrl = 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= defaultE2eDatabaseUrl;

// The config is evaluated before Playwright imports any spec. This keeps a
// direct `npx playwright test` from reaching the spec-level TRUNCATE with an
// inherited staging/production DATABASE_URL.
execFileSync(process.execPath, [fileURLToPath(new URL('./scripts/assert-test-database.mjs', import.meta.url))], {
  env: process.env,
  stdio: ['ignore', 'ignore', 'inherit'],
});

// Browser tests and their web-server child process must sign HMAC links with
// the same deterministic test-only key.
process.env.ADMIN_COOKIE_SECRET ??= 'e2e-test-admin-cookie-secret-000000000001';
process.env.IP_HASH_SECRET ??= 'e2e-test-ip-hash-secret-0000000000000001';
process.env.MEDIA_STORAGE_PROVIDER ??= 'test_fake';
process.env.STT_PROVIDER ??= 'test_fake';
process.env.AI_ENRICHMENT_PROVIDER ??= 'test_fake';

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
      'PORT=5175 PUBLIC_SITE_URL=http://127.0.0.1:5175 NODE_ENV=test EMAIL_MODE=log E2E_EMAIL_OUTBOX_ENABLED=on TELEGRAM_NOTIFY_MODE=log PLATFORM_ACCOUNTS_ENABLED=on CREATOR_DASHBOARD_ENABLED=on PUBLIC_CATALOG_ENABLED=on TENANT_CRM_ENABLED=on MEDIA_STORAGE_PROVIDER=test_fake STT_PROVIDER=test_fake AI_ENRICHMENT_PROVIDER=test_fake WEBINAR_VIDEO_PROVIDER=local WEBINAR_VIDEO_HLS_URL= WEBINAR_VIDEO_URL=http://127.0.0.1:5175/crisis_premium/assets/webinar.mp4 WEBINAR_TEST_ROOM_MODE=off WEBINAR_PREVIEW_MODE=on WORKER_ROLE=api npx tsx src/server.ts',
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
