process.env.DATABASE_URL ??= 'postgresql://aspb:aspb@localhost:5432/aspb_autowebinar?schema=test';
process.env.NODE_ENV = 'test';

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('20260823130000 media/STT durability additive migration', () => {
  it('preserves a non-empty pre-migration schema and passes read-only pre/postflight', () => {
    const guard = spawnSync(process.execPath, ['scripts/assert-test-database.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    expect(guard.status, `${guard.stdout}\n${guard.stderr}`).toBe(0);

    const schema = `media_stt_migration_${process.pid}`;
    const target = '20260823130000_media_stt_durability_hardening';
    const migrationRoot = resolve('prisma/migrations');
    const migrations = readdirSync(migrationRoot)
      .filter(name => /^\d+/.test(name) && name < target)
      .sort();
    const temporary = mkdtempSync(join(tmpdir(), 'aspb-media-stt-migration-'));
    const script = join(temporary, 'fixture.sql');
    const include = (path: string) => `\\i '${path.replaceAll("'", "''")}'`;
    const sql = [
      '\\set ON_ERROR_STOP on',
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
      `CREATE SCHEMA "${schema}";`,
      `SET search_path TO "${schema}";`,
      ...migrations.map(name => include(join(migrationRoot, name, 'migration.sql'))),
      include(resolve('tests/fixtures/media-stt-durability-nonempty.sql')),
      include(resolve('prisma/checks/20260823130000_media_stt_durability_hardening_preflight.sql')),
      include(resolve('prisma/migrations', target, 'migration.sql')),
      include(resolve('prisma/checks/20260823130000_media_stt_durability_hardening_postflight.sql')),
      include(resolve('prisma/checks/20260823131000_media_upload_completion_claim_preflight.sql')),
      include(resolve('prisma/migrations/20260823131000_media_upload_completion_claim/migration.sql')),
      include(resolve('prisma/checks/20260823131000_media_upload_completion_claim_postflight.sql')),
      `DO $$
      DECLARE snapshot RECORD;
      BEGIN
        SELECT * INTO snapshot FROM "media_stt_fixture_counts";
        IF snapshot.media_assets <> (SELECT COUNT(*) FROM "media_assets")
          OR snapshot.media_uploads <> (SELECT COUNT(*) FROM "media_uploads")
          OR snapshot.content_jobs <> (SELECT COUNT(*) FROM "content_jobs")
          OR snapshot.provenance <> (SELECT COUNT(*) FROM "ai_operation_provenance") THEN
          RAISE EXCEPTION 'media/STT durability expand changed legacy row counts';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM "media_uploads"
          WHERE "id"='media_stt_fixture_upload' AND "abort_attempts"=0
            AND "idempotency_key" IS NULL AND "request_hash" IS NULL
        ) OR NOT EXISTS (
          SELECT 1 FROM "content_jobs"
          WHERE "id"='media_stt_fixture_job' AND "provider_id" IS NULL
            AND "provider_job_id" IS NULL AND "claim_expires_at" IS NULL
        ) OR NOT EXISTS (
          SELECT 1 FROM "media_assets"
          WHERE "id"='media_stt_fixture_asset' AND "speech_size_bytes" IS NULL
            AND "renditions_metadata_json" IS NULL
        ) OR NOT EXISTS (
          SELECT 1 FROM "ai_operation_provenance"
          WHERE "id"='media_stt_fixture_provenance' AND "provider_model_version" IS NULL
        ) OR NOT EXISTS (
          SELECT 1 FROM "media_uploads"
          WHERE "id"='media_stt_fixture_upload' AND "complete_claim_token" IS NULL
            AND "complete_claim_expires_at" IS NULL
        ) THEN
          RAISE EXCEPTION 'media/STT durability expand did not preserve legacy-safe defaults';
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
      expect(result.stdout).toContain('duplicate_stt_provider_bindings');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
