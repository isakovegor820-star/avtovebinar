import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('TEN-001 tenant foundation migration', () => {
  it('backfills a non-empty legacy schema without changing counts or promoting AdminUser', () => {
    const guard = spawnSync(process.execPath, ['scripts/assert-test-database.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    expect(guard.status, `${guard.stdout}\n${guard.stderr}`).toBe(0);
    const result = spawnSync(
      process.execPath,
      [
        'scripts/run-libpq-command.mjs',
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        'tests/fixtures/tenant-foundation-legacy-migration.sql',
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
