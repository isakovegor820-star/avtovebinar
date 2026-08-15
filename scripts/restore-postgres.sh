#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" || -L "$BACKUP_FILE" || "$BACKUP_FILE" == *.part ]]; then
  echo "Usage: RESTORE_TARGET=recovery npm run restore:db -- backups/aspb-postgres-YYYYMMDDTHHMMSSZ.sql.gz" >&2
  exit 1
fi

for required_command in gzip; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

# Verify the complete compressed stream and its format before opening any
# database connection. A partial/corrupt file must never reach psql.
gzip -t "$BACKUP_FILE"
dump_header="$(gzip -dc "$BACKUP_FILE" | sed -n '1,8p')"
if [[ "$dump_header" != *"PostgreSQL database dump"* ]]; then
  echo "Restore refused: PostgreSQL dump header is missing" >&2
  exit 1
fi

RESTORE_TARGET="${RESTORE_TARGET:-}"
case "$RESTORE_TARGET" in
  recovery)
    ;;
  production)
    if [[ "${CONFIRM_PRODUCTION_RESTORE:-}" != "RESTORE_PRODUCTION_IN_PLACE" ]]; then
      echo "Production in-place restore requires CONFIRM_PRODUCTION_RESTORE=RESTORE_PRODUCTION_IN_PLACE" >&2
      exit 1
    fi
    echo "WARNING: explicitly confirmed production in-place restore." >&2
    ;;
  *)
    echo "RESTORE_TARGET must be explicitly set to recovery or production" >&2
    exit 1
    ;;
esac

if [[ -n "${PG_DATABASE_URL:-${DATABASE_URL:-}}" ]]; then
  if ! command -v node >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
    echo "node and psql are required for native PostgreSQL restore" >&2
    exit 1
  fi
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  if [[ "$RESTORE_TARGET" == "recovery" ]]; then
    node "$script_dir/run-libpq-command.mjs" --validate-recovery
  fi
  gzip -dc "$BACKUP_FILE" | node "$script_dir/run-libpq-command.mjs" \
    psql -v ON_ERROR_STOP=1 --single-transaction
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required when PG_DATABASE_URL and DATABASE_URL are not set" >&2
    exit 1
  fi
  COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
  COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.production}"
  POSTGRES_USER="${POSTGRES_USER:-aspb}"
  POSTGRES_DB="${POSTGRES_DB:-aspb_autowebinar}"

  if [[ ! -f "$COMPOSE_FILE" || ! -f "$COMPOSE_ENV_FILE" ]]; then
    echo "COMPOSE_FILE and COMPOSE_ENV_FILE must both exist" >&2
    exit 1
  fi
  if [[ "$RESTORE_TARGET" == "recovery" && ! "$POSTGRES_DB" =~ (^|[_-])(recovery|restore|restored|test|testing|staging)([_-]|$) ]]; then
    echo "Recovery POSTGRES_DB must contain an explicit recovery/restore/test/staging marker" >&2
    exit 1
  fi

  compose=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE")
  "${compose[@]}" config --quiet
  if ! "${compose[@]}" config --services | grep -qx postgres; then
    echo "Selected compose file has no postgres service" >&2
    exit 1
  fi
  gzip -dc "$BACKUP_FILE" | "${compose[@]}" exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction
fi

echo "Backup restored successfully to explicit $RESTORE_TARGET target: $BACKUP_FILE"
