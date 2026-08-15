#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TEST_NAME_PATTERN = /(^|[_-])(test|testing|ci|e2e)([_-]|$)/i;

export function assertSafeTestDatabaseUrl(rawUrl = process.env.DATABASE_URL, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== 'test') {
    throw new Error('Refusing test database setup unless NODE_ENV=test');
  }

  if (!rawUrl) {
    throw new Error('DATABASE_URL is required for test database setup');
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Only PostgreSQL URLs are allowed for test database setup');
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing test database setup on non-loopback host: ${url.hostname}`);
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const schemaName = url.searchParams.get('schema') ?? '';
  if (!TEST_NAME_PATTERN.test(databaseName) && !TEST_NAME_PATTERN.test(schemaName)) {
    throw new Error('Test database name or schema must contain an explicit test/ci/e2e marker');
  }

  return { databaseName, schemaName, hostname: url.hostname };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const target = assertSafeTestDatabaseUrl();
    console.log(`Safe test database target confirmed: ${target.hostname}/${target.databaseName} schema=${target.schemaName || 'public'}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
