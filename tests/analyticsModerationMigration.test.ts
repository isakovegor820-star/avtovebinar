process.env.DATABASE_URL ??= 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.NODE_ENV = 'test';

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('20260823120000 analytics/moderation additive migration', () => {
  it('preserves a non-empty pre-migration schema and passes read-only pre/postflight', () => {
    const guard = spawnSync(process.execPath, ['scripts/assert-test-database.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    expect(guard.status, `${guard.stdout}\n${guard.stderr}`).toBe(0);

    const schema = `ana_mod_migration_${process.pid}`;
    const migrationRoot = resolve('prisma/migrations');
    const migrations = readdirSync(migrationRoot)
      .filter(name => /^\d+/.test(name) && name < '20260823120000_analytics_moderation_platform')
      .sort();
    const temporary = mkdtempSync(join(tmpdir(), 'aspb-ana-mod-migration-'));
    const script = join(temporary, 'fixture.sql');
    const include = (path: string) => `\\i '${path.replaceAll("'", "''")}'`;
    const sql = [
      '\\set ON_ERROR_STOP on',
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
      `CREATE SCHEMA "${schema}";`,
      `SET search_path TO "${schema}";`,
      ...migrations.map(name => include(join(migrationRoot, name, 'migration.sql'))),
      include(resolve('tests/fixtures/analytics-moderation-platform-nonempty.sql')),
      include(resolve('prisma/checks/20260823120000_analytics_moderation_platform_preflight.sql')),
      include(resolve('prisma/migrations/20260823120000_analytics_moderation_platform/migration.sql')),
      include(resolve('prisma/checks/20260823120000_analytics_moderation_platform_postflight.sql')),
      `DO $$
      DECLARE snapshot RECORD;
      BEGIN
        SELECT * INTO snapshot FROM "analytics_moderation_fixture_counts";
        IF snapshot.organizations <> (SELECT COUNT(*) FROM "organizations")
          OR snapshot.webinars <> (SELECT COUNT(*) FROM "webinars")
          OR snapshot.events <> (SELECT COUNT(*) FROM "events") THEN
          RAISE EXCEPTION 'analytics/moderation expand changed legacy row counts';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id"='migration_fixture_org' AND "platform_revision"=1)
          OR NOT EXISTS (SELECT 1 FROM "webinars" WHERE "id"='migration_fixture_webinar' AND "moderation_revision"=0)
          OR NOT EXISTS (SELECT 1 FROM "events" WHERE "id"='migration_fixture_legacy_event' AND "schema_version"=0)
          OR (SELECT COUNT(*) FROM "content_reports") <> 0
          OR (SELECT COUNT(*) FROM "moderation_correction_requests") <> 0
          OR (SELECT COUNT(*) FROM "platform_feature_flags" WHERE "enabled"=FALSE) <> 4 THEN
          RAISE EXCEPTION 'analytics/moderation expand did not preserve defaults or invented case data';
        END IF;
      END $$;`,
      'SET search_path TO public;',
      `DROP SCHEMA "${schema}" CASCADE;`,
    ].join('\n');
    writeFileSync(script, sql, { encoding: 'utf8', mode: 0o600 });
    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/run-libpq-command.mjs', 'psql', '-v', 'ON_ERROR_STOP=1', '-f', script],
        { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('content_report_scope_violations');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
