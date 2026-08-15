#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PRISMA_ONLY_PARAMETERS = new Set([
  'schema',
  'connection_limit',
  'pool_timeout',
  'pgbouncer',
  'statement_cache_size',
  'socket_timeout',
  'sslaccept',
]);

const LIBPQ_ENV_PARAMETERS = new Map([
  ['application_name', 'PGAPPNAME'],
  ['channel_binding', 'PGCHANNELBINDING'],
  ['client_encoding', 'PGCLIENTENCODING'],
  ['connect_timeout', 'PGCONNECT_TIMEOUT'],
  ['dbname', 'PGDATABASE'],
  ['gssencmode', 'PGGSSENCMODE'],
  ['host', 'PGHOST'],
  ['hostaddr', 'PGHOSTADDR'],
  ['keepalives', 'PGKEEPALIVES'],
  ['keepalives_count', 'PGKEEPALIVESCOUNT'],
  ['keepalives_idle', 'PGKEEPALIVESIDLE'],
  ['keepalives_interval', 'PGKEEPALIVESINTERVAL'],
  ['krbsrvname', 'PGKRBSRVNAME'],
  ['options', 'PGOPTIONS'],
  ['passfile', 'PGPASSFILE'],
  ['password', 'PGPASSWORD'],
  ['port', 'PGPORT'],
  ['requiressl', 'PGREQUIRESSL'],
  ['service', 'PGSERVICE'],
  ['servicefile', 'PGSERVICEFILE'],
  ['sslcert', 'PGSSLCERT'],
  ['sslcompression', 'PGSSLCOMPRESSION'],
  ['sslcrl', 'PGSSLCRL'],
  ['sslkey', 'PGSSLKEY'],
  ['sslmode', 'PGSSLMODE'],
  ['sslpassword', 'PGSSLPASSWORD'],
  ['sslrootcert', 'PGSSLROOTCERT'],
  ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
  ['tcp_user_timeout', 'PGTCPUSERTIMEOUT'],
  ['user', 'PGUSER'],
]);
function decodeUrlPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('PostgreSQL connection URL contains invalid percent-encoding');
  }
}

export function buildLibpqInvocation(rawUrl, command, passthroughArgs = []) {
  if (!rawUrl) throw new Error('PG_DATABASE_URL or DATABASE_URL is required');
  if (!['pg_dump', 'psql'].includes(command)) throw new Error('Only pg_dump and psql are allowed');

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('PostgreSQL connection URL is invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('PostgreSQL connection URL must use postgres:// or postgresql://');
  }

  const database = decodeUrlPart(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('PostgreSQL connection URL must include a database name');

  const env = {
    PGHOST: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    PGDATABASE: database,
  };
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeUrlPart(url.username);
  if (url.password) env.PGPASSWORD = decodeUrlPart(url.password);

  const prismaParameters = new Map();
  for (const [name, value] of url.searchParams) {
    if (PRISMA_ONLY_PARAMETERS.has(name)) {
      prismaParameters.set(name, value);
      continue;
    }
    const envName = LIBPQ_ENV_PARAMETERS.get(name);
    if (!envName) throw new Error(`Unsupported PostgreSQL connection parameter: ${name}`);
    env[envName] = value;
  }

  const schema = prismaParameters.get('schema')?.trim();
  if (schema && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) {
    throw new Error('Prisma schema must be a simple PostgreSQL identifier for backup/restore');
  }

  const args = [...passthroughArgs];
  if (command === 'pg_dump' && schema) {
    args.unshift(`--schema=${schema}`);
  }
  if (command === 'psql' && schema) {
    const searchPathOption = `-c search_path=${schema}`;
    env.PGOPTIONS = env.PGOPTIONS ? `${env.PGOPTIONS} ${searchPathOption}` : searchPathOption;
  }

  return { command, args, env, schema: schema || null };
}

function fail(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function main() {
  const requestedCommand = process.argv[2];
  const rawUrl = process.env.PG_DATABASE_URL || process.env.DATABASE_URL;

  if (requestedCommand === '--validate') {
    try {
      buildLibpqInvocation(rawUrl, process.argv[3] || 'pg_dump');
      process.exit(0);
    } catch (error) {
      fail(error);
    }
  }

  if (requestedCommand === '--validate-recovery') {
    try {
      const target = buildLibpqInvocation(rawUrl, 'psql');
      const marker = /(^|[_-])(recovery|restore|restored|test|testing|staging)([_-]|$)/i;
      if (!marker.test(target.env.PGDATABASE) && !marker.test(target.schema || '')) {
        throw new Error('Recovery database or schema must contain an explicit recovery/restore/test/staging marker');
      }
      process.exit(0);
    } catch (error) {
      fail(error);
    }
  }

  let invocation;
  try {
    invocation = buildLibpqInvocation(rawUrl, requestedCommand, process.argv.slice(3));
  } catch (error) {
    fail(error);
  }

  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  for (const envName of Object.keys(childEnv)) {
    if (envName.startsWith('PG')) delete childEnv[envName];
  }
  Object.assign(childEnv, invocation.env);

  const result = spawnSync(invocation.command, invocation.args, {
    env: childEnv,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) fail(result.error);
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
