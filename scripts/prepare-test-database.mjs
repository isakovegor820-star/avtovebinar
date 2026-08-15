#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { assertSafeTestDatabaseUrl } from './assert-test-database.mjs';

try {
  assertSafeTestDatabaseUrl();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(command, ['--no-install', 'prisma', 'migrate', 'reset', '--force', '--skip-seed'], {
  env: process.env,
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
