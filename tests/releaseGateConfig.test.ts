import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspaceFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('release gate configuration', () => {
  it('waits for the dependency-aware Playwright readiness probe', () => {
    const config = workspaceFile('playwright.config.ts');

    expect(config).toContain("url: 'http://127.0.0.1:5175/health/ready'");
    expect(config).toContain('timeout: 120_000');
    expect(config).not.toContain('npx tsx src/server.ts');
  });

  it('uses the pinned local Prisma CLI without npx resolution', () => {
    const prepareScript = workspaceFile('scripts/prepare-test-database.mjs');

    expect(prepareScript).toContain("new URL('../node_modules/prisma/build/index.js'");
    expect(prepareScript).toContain('const command = process.execPath');
    expect(prepareScript).not.toContain("const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'");
  });

  it('keeps database preparation behind the explicit test-target guard', () => {
    const prepareScript = workspaceFile('scripts/prepare-test-database.mjs');
    const guard = workspaceFile('scripts/assert-test-database.mjs');

    expect(prepareScript).toContain('assertSafeTestDatabaseUrl()');
    expect(guard).toContain("if (nodeEnv !== 'test')");
    expect(guard).toContain('LOOPBACK_HOSTS');
    expect(guard).toContain('TEST_NAME_PATTERN');
    expect(prepareScript).toContain("where: { id: 'webinar_aspb_legacy' }");
    expect(prepareScript).toContain('Restored deterministic test control-plane invariants.');
  });

  it('keeps production behind deployed staging smoke and preserves browser evidence', () => {
    const workflow = workspaceFile('.github/workflows/ci.yml');
    const packageJson = workspaceFile('package.json');

    expect(workflow).toContain('container-build, deploy-staging, staging-smoke]');
    expect(workflow).toContain('playwright-evidence-${{ github.sha }}');
    expect(workflow).toContain('staging-smoke-${{ github.sha }}');
    expect(workflow).toContain('npm audit');
    expect(packageJson).toContain('"release:verify"');
  });

  it('keeps STAGING provisioning explicit and isolated from production runtime resources', () => {
    const workflow = workspaceFile('.github/workflows/ci.yml');
    const provisioning = workspaceFile('scripts/provision-staging-host.sh');

    expect(workflow).toContain("inputs.deploy_target == 'staging-provision'");
    expect(workflow).toContain('inputs.confirm_staging_provision');
    expect(workflow).toContain('COMPOSE_PROJECT_NAME=aspb-platform-staging');
    expect(workflow).toContain('ASPB_CONTAINER_PREFIX=aspb-platform-staging');
    expect(workflow).toContain('ASPB_BIND_PORT=5176');
    expect(provisioning).toContain('expected_public_host="staging.72-56-38-62.sslip.io"');
    expect(provisioning).toContain('expected_postgres_container="aspb-platform-staging-postgres"');
    expect(provisioning).toContain('staging_database="aspb_staging"');
    expect(provisioning).toContain('staging_certificate_name="aspb-autowebinar-staging"');
    expect(provisioning).toContain('--cert-name "$staging_certificate_name"');
    expect(provisioning).toContain('set_env_value EMAIL_MODE log');
    expect(provisioning).toContain('set_env_value TELEGRAM_NOTIFY_MODE log');
    expect(provisioning).not.toContain('aspb-partners-postgres');
  });

  it('keeps analytics metadata validation resolvable during pg_dump restore', () => {
    const migration = workspaceFile('prisma/migrations/20260825150000_restore_safe_analytics_function/migration.sql');

    expect(migration).toContain('ALTER FUNCTION analytics_metadata_is_safe(JSONB, INTEGER)');
    expect(migration).toContain('SET search_path FROM CURRENT');
  });

  it('keeps creator autosave command persistence allowed by the database', () => {
    const migration = workspaceFile('prisma/migrations/20260825151000_webinar_metadata_command/migration.sql');

    expect(migration).toContain("'metadata_update'");
    expect(migration).toContain('webinar_commands_action_check');
  });
});
