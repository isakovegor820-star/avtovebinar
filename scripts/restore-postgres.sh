#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "Usage: npm run restore:db -- backups/aspb-postgres-YYYYMMDDTHHMMSSZ.sql.gz" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  gunzip -c "$BACKUP_FILE" | psql "$DATABASE_URL"
else
  COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
  POSTGRES_USER="${POSTGRES_USER:-aspb}"
  POSTGRES_DB="${POSTGRES_DB:-aspb_autowebinar}"
  gunzip -c "$BACKUP_FILE" | docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
fi

echo "Backup restored: $BACKUP_FILE"
