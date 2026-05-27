#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="${BACKUP_DIR}/aspb-postgres-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump "$DATABASE_URL" | gzip > "$OUTPUT"
else
  COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
  POSTGRES_USER="${POSTGRES_USER:-aspb}"
  POSTGRES_DB="${POSTGRES_DB:-aspb_autowebinar}"
  docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "$OUTPUT"
fi

echo "Backup created: $OUTPUT"
