#!/usr/bin/env bash

set -Eeuo pipefail

COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-backups}"

for required_command in node pg_dump; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command for native PostgreSQL backup: $required_command" >&2
    exit 1
  fi
done

bash scripts/assert-private-env-file.sh "$COMPOSE_ENV_FILE"

database_url="$(
  node --env-file="$COMPOSE_ENV_FILE" --input-type=module -e '
    const value = process.env.PG_DATABASE_URL || process.env.DATABASE_URL || "";
    if (!value) {
      console.error("PG_DATABASE_URL or DATABASE_URL is required for a deploy backup");
      process.exit(1);
    }
    process.stdout.write(value);
  '
)"

PG_DATABASE_URL="$database_url" \
BACKUP_DIR="$BACKUP_DIR" \
  bash scripts/backup-postgres.sh
unset database_url
