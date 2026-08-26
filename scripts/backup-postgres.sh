#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

if [[ ! "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
  exit 1
fi

for required_command in gzip; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

mkdir -p "$BACKUP_DIR"
if [[ ! -d "$BACKUP_DIR" || -L "$BACKUP_DIR" ]]; then
  echo "BACKUP_DIR must be a real directory, not a symlink: $BACKUP_DIR" >&2
  exit 1
fi

umask 077
LOCK_MODE=""
LOCK_DIR="$BACKUP_DIR/.aspb-postgres-backup.lock.d"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_DIR/.aspb-postgres-backup.lock"
  if ! flock -n 9; then
    echo "Another PostgreSQL backup is already running" >&2
    exit 75
  fi
  LOCK_MODE="flock"
else
  # macOS does not ship flock. Atomic mkdir keeps the same fail-closed
  # single-writer guarantee for local recovery drills.
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "Another PostgreSQL backup is already running (lock: $LOCK_DIR)" >&2
    exit 75
  fi
  LOCK_MODE="directory"
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="$BACKUP_DIR/aspb-postgres-$TIMESTAMP.sql.gz"
if [[ -e "$OUTPUT" ]]; then
  echo "Refusing to overwrite an existing backup: $OUTPUT" >&2
  exit 1
fi

TEMP_OUTPUT="$(mktemp "$BACKUP_DIR/.aspb-postgres-$TIMESTAMP.XXXXXX.sql.gz.part")"
cleanup() {
  if [[ -n "${TEMP_OUTPUT:-}" && -f "$TEMP_OUTPUT" ]]; then
    rm -f -- "$TEMP_OUTPUT"
  fi
  if [[ "${LOCK_MODE:-}" == "directory" && -d "${LOCK_DIR:-}" ]]; then
    rmdir -- "$LOCK_DIR"
  fi
}
trap cleanup EXIT INT TERM

if [[ -n "${PG_DATABASE_URL:-${DATABASE_URL:-}}" ]]; then
  if ! command -v node >/dev/null 2>&1 || ! command -v pg_dump >/dev/null 2>&1; then
    echo "node and pg_dump are required when PG_DATABASE_URL or DATABASE_URL is used" >&2
    exit 1
  fi
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  node "$script_dir/run-libpq-command.mjs" pg_dump | gzip -c >"$TEMP_OUTPUT"
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required when DATABASE_URL is not set" >&2
    exit 1
  fi
  COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
  COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.production}"
  POSTGRES_USER="${POSTGRES_USER:-aspb}"
  POSTGRES_DB="${POSTGRES_DB:-aspb_autowebinar}"

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "Compose file not found: $COMPOSE_FILE" >&2
    exit 1
  fi
  if [[ ! -f "$COMPOSE_ENV_FILE" ]]; then
    echo "Compose environment file not found: $COMPOSE_ENV_FILE" >&2
    exit 1
  fi

  compose=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE")
  "${compose[@]}" config --quiet
  if ! "${compose[@]}" config --services | grep -qx postgres; then
    echo "Selected compose file has no postgres service; set PG_DATABASE_URL or DATABASE_URL for native PostgreSQL" >&2
    exit 1
  fi
  "${compose[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip -c >"$TEMP_OUTPUT"
fi

if [[ ! -s "$TEMP_OUTPUT" ]]; then
  echo "Backup stream is empty" >&2
  exit 1
fi
gzip -t "$TEMP_OUTPUT"
dump_header="$(gzip -dc "$TEMP_OUTPUT" | sed -n '1,8p')"
if [[ "$dump_header" != *"PostgreSQL database dump"* ]]; then
  echo "Backup verification failed: PostgreSQL dump header is missing" >&2
  exit 1
fi

chmod 600 "$TEMP_OUTPUT"
mv "$TEMP_OUTPUT" "$OUTPUT"
TEMP_OUTPUT=""
cleanup
trap - EXIT INT TERM

echo "Backup created and verified: $OUTPUT"

# Retention runs only after a verified backup was published atomically. It is
# restricted to this application's final backup files in this one directory.
find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name 'aspb-postgres-*.sql.gz' \
  -mtime "+$BACKUP_RETENTION_DAYS" \
  -print -delete
