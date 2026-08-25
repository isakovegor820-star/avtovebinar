#!/usr/bin/env bash

set -Eeuo pipefail

for required_command in docker git flock gzip readlink realpath; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/aspb-autowebinar-deploy.lock}"
if [[ "$DEPLOY_LOCK_FILE" != /* ]]; then
  echo "DEPLOY_LOCK_FILE must be absolute" >&2
  exit 1
fi
if [[ "${DEPLOY_LOCK_HELD:-off}" == "on" ]]; then
  expected_lock_target="$(realpath -m -- "$DEPLOY_LOCK_FILE")"
  inherited_lock_target="$(readlink "/proc/$$/fd/9" 2>/dev/null || true)"
  if [[ "$inherited_lock_target" != "$expected_lock_target" ]] || ! flock -n 9; then
    echo "DEPLOY_LOCK_HELD=on requires inherited fd 9 to hold $expected_lock_target" >&2
    exit 1
  fi
else
  exec 9>"$DEPLOY_LOCK_FILE"
  if ! flock -n 9; then
    echo "Another deployment is already running (lock: $DEPLOY_LOCK_FILE)" >&2
    exit 75
  fi
fi

source scripts/release-safety.sh

if [[ -z "${DEPLOY_COMMIT_SHA:-}" || ! "$DEPLOY_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_COMMIT_SHA must be the exact 40-character commit SHA to deploy" >&2
  exit 1
fi

actual_commit_sha="$(git rev-parse HEAD)"
if [[ "$actual_commit_sha" != "$DEPLOY_COMMIT_SHA" ]]; then
  echo "Refusing deploy: HEAD is $actual_commit_sha, expected $DEPLOY_COMMIT_SHA" >&2
  exit 1
fi

verified_ci_sha="${DEPLOY_VERIFIED_CI_SHA:-}"
verified_ci_run_url="${DEPLOY_VERIFIED_CI_RUN_URL:-}"
github_repository="${DEPLOY_GITHUB_REPOSITORY:-}"
source_ref="${DEPLOY_SOURCE_REF:-}"
deploy_environment="${DEPLOY_ENVIRONMENT:-}"
origin_url="$(git remote get-url origin 2>/dev/null || true)"
origin_without_suffix="${origin_url%.git}"
case "$origin_without_suffix" in
  https://github.com/*) trusted_github_repository="${origin_without_suffix#https://github.com/}" ;;
  git@github.com:*) trusted_github_repository="${origin_without_suffix#git@github.com:}" ;;
  ssh://git@github.com/*) trusted_github_repository="${origin_without_suffix#ssh://git@github.com/}" ;;
  *)
    echo "Origin must be an attributable github.com repository for attested deployment" >&2
    exit 1
    ;;
esac
if [[ ! "$trusted_github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Could not derive a safe owner/repository identity from origin" >&2
  exit 1
fi
if [[ "$github_repository" != "$trusted_github_repository" ]]; then
  echo "DEPLOY_GITHUB_REPOSITORY does not match the checked-out origin repository" >&2
  exit 1
fi
if [[ "$verified_ci_sha" != "$DEPLOY_COMMIT_SHA" ]]; then
  echo "DEPLOY_VERIFIED_CI_SHA must equal DEPLOY_COMMIT_SHA" >&2
  exit 1
fi
verified_ci_run_prefix="https://github.com/$trusted_github_repository/actions/runs/"
verified_ci_run_id="${verified_ci_run_url#"$verified_ci_run_prefix"}"
if [[ "$verified_ci_run_url" != "$verified_ci_run_prefix"* || ! "$verified_ci_run_id" =~ ^[0-9]+$ ]]; then
  echo "DEPLOY_VERIFIED_CI_RUN_URL must identify a run in the trusted repository" >&2
  exit 1
fi
if [[ ! "$source_ref" =~ ^refs/(heads|tags)/[A-Za-z0-9._/-]+$ || "$source_ref" == *".."* ]]; then
  echo "DEPLOY_SOURCE_REF must be a safe full Git ref" >&2
  exit 1
fi
case "$deploy_environment" in
  staging) ;;
  production)
    if [[ "$source_ref" != "refs/heads/main" ]]; then
      echo "Production deployment requires DEPLOY_SOURCE_REF=refs/heads/main" >&2
      exit 1
    fi
    ;;
  *)
    echo "DEPLOY_ENVIRONMENT must be staging or production" >&2
    exit 1
    ;;
esac
if [[ "${ALLOW_DEPLOY_WITHOUT_CI_ATTESTATION:-off}" == "on" ]]; then
  echo "ALLOW_DEPLOY_WITHOUT_CI_ATTESTATION is no longer supported; signed provenance is mandatory" >&2
  exit 1
fi
bash scripts/assert-clean-deploy-worktree.sh

if [[ -z "${COMPOSE_FILE:-}" ]]; then
  echo "COMPOSE_FILE must explicitly select a reviewed deployment compose file" >&2
  exit 1
fi
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env.production}"

if [[ "$COMPOSE_FILE" = /* || "$COMPOSE_FILE" == *"../"* ]]; then
  echo "COMPOSE_FILE must be a repository-relative path without '..' traversal" >&2
  exit 1
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi
if [[ ! -f "$COMPOSE_ENV_FILE" ]]; then
  echo "Compose environment file not found: $COMPOSE_ENV_FILE" >&2
  exit 1
fi
if ! git ls-files --error-unmatch -- "$COMPOSE_FILE" >/dev/null 2>&1; then
  echo "Refusing untracked compose file: $COMPOSE_FILE" >&2
  exit 1
fi

deploy_database_mode=docker
if [[ "$COMPOSE_FILE" == "docker-compose.native-postgres.yml" ]]; then
  deploy_database_mode=native
  if [[ -z "${NATIVE_POSTGRES_STORAGE_PATH:-}" || "$NATIVE_POSTGRES_STORAGE_PATH" != /* || ! -d "$NATIVE_POSTGRES_STORAGE_PATH" ]]; then
    echo "NATIVE_POSTGRES_STORAGE_PATH must be an existing absolute directory for docker-compose.native-postgres.yml" >&2
    exit 1
  fi
fi

export COMPOSE_ENV_FILE
bash scripts/assert-private-env-file.sh "$COMPOSE_ENV_FILE"

if [[ -n "${DEPLOY_IMAGE_TAG:-}" && "$DEPLOY_IMAGE_TAG" != "$DEPLOY_COMMIT_SHA" ]]; then
  echo "DEPLOY_IMAGE_TAG must equal DEPLOY_COMMIT_SHA for an attributable release" >&2
  exit 1
fi
export DEPLOY_IMAGE_TAG="$DEPLOY_COMMIT_SHA"
compose=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE")

"${compose[@]}" config --quiet
available_services="$("${compose[@]}" config --services)"

has_service() {
  local expected="$1"
  printf '%s\n' "$available_services" | grep -qx "$expected"
}

if ! has_service api; then
  echo "Selected compose file does not define the required api service" >&2
  exit 1
fi

deploy_services=(api)
if has_service webinar-worker; then
  deploy_services+=(webinar-worker)
fi

api_release_image="aspb-autowebinar-api:$DEPLOY_IMAGE_TAG"
worker_release_image="aspb-autowebinar-worker:$DEPLOY_IMAGE_TAG"
configured_images="$("${compose[@]}" config --images)"
if ! printf '%s\n' "$configured_images" | grep -Fxq "$api_release_image"; then
  echo "Compose api image must resolve to $api_release_image" >&2
  exit 1
fi
if has_service webinar-worker && ! printf '%s\n' "$configured_images" | grep -Fxq "$worker_release_image"; then
  echo "Compose webinar-worker image must resolve to $worker_release_image" >&2
  exit 1
fi

verify_image_revision() {
  local image_ref="$1"
  local revision compatibility
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")"
  compatibility="$(docker image inspect --format '{{index .Config.Labels "com.aspb.schema.compatibility"}}' "$image_ref")"
  if [[ "$revision" != "$DEPLOY_COMMIT_SHA" || "$compatibility" != "$ASPB_SCHEMA_COMPATIBILITY_VERSION" ]]; then
    echo "Refusing image with unverifiable revision/schema compatibility: $image_ref" >&2
    return 1
  fi
}

verify_container_revision() {
  local service="$1"
  local container_id revision
  container_id="$("${compose[@]}" ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    echo "Cannot verify provenance: service $service has no container" >&2
    return 1
  fi
  revision="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container_id")"
  if [[ "$revision" != "$DEPLOY_COMMIT_SHA" ]]; then
    echo "Running service $service reports revision ${revision:-missing}, expected $DEPLOY_COMMIT_SHA" >&2
    return 1
  fi
}

VERIFIED_BACKUP_MAX_AGE_SECONDS="${VERIFIED_BACKUP_MAX_AGE_SECONDS:-86400}"
if [[ ! "$VERIFIED_BACKUP_MAX_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "VERIFIED_BACKUP_MAX_AGE_SECONDS must be a positive integer" >&2
  exit 1
fi

verified_backup="${VERIFIED_BACKUP_FILE:-}"
if [[ -z "$verified_backup" ]]; then
  if [[ "${ALLOW_DEPLOY_WITHOUT_VERIFIED_BACKUP:-off}" != "on" ]]; then
    echo "VERIFIED_BACKUP_FILE is required before forward-only migrations" >&2
    exit 1
  fi
  echo "WARNING: operator explicitly allowed deployment without a verified backup." >&2
else
  if [[ ! -f "$verified_backup" || -L "$verified_backup" || "$verified_backup" == *.part ]]; then
    echo "VERIFIED_BACKUP_FILE must be a regular final backup file, not a symlink or .part: $verified_backup" >&2
    exit 1
  fi
  if [[ "$verified_backup" != *.sql.gz ]]; then
    echo "VERIFIED_BACKUP_FILE must end with .sql.gz" >&2
    exit 1
  fi

  backup_modified_at=""
  if backup_modified_at="$(stat -c %Y "$verified_backup" 2>/dev/null)"; then
    :
  elif backup_modified_at="$(stat -f %m "$verified_backup" 2>/dev/null)"; then
    :
  else
    echo "Could not determine backup modification time: $verified_backup" >&2
    exit 1
  fi
  now_epoch="$(date +%s)"
  backup_age_seconds="$((now_epoch - backup_modified_at))"
  if (( backup_age_seconds < -300 )); then
    echo "Verified backup timestamp is unexpectedly in the future: $verified_backup" >&2
    exit 1
  fi
  if (( backup_age_seconds > VERIFIED_BACKUP_MAX_AGE_SECONDS )); then
    echo "Verified backup is stale (${backup_age_seconds}s > ${VERIFIED_BACKUP_MAX_AGE_SECONDS}s): $verified_backup" >&2
    exit 1
  fi

  gzip -t "$verified_backup"
  verified_backup_header="$(gzip -dc "$verified_backup" | sed -n '1,8p')"
  if [[ "$verified_backup_header" != *"PostgreSQL database dump"* ]]; then
    echo "Verified backup does not contain a PostgreSQL dump header: $verified_backup" >&2
    exit 1
  fi
  echo "Verified fresh pre-deploy backup: $verified_backup (${backup_age_seconds}s old)"
fi

previous_api_container="$("${compose[@]}" ps -q api 2>/dev/null || true)"
previous_worker_container=""
previous_api_image_id=""
previous_api_image_ref=""
previous_worker_image_id=""
previous_worker_image_ref=""
previous_schema_compatibility=""

if [[ -n "$previous_api_container" ]]; then
  previous_api_image_id="$(docker inspect --format '{{.Image}}' "$previous_api_container")"
  previous_api_image_ref="$(docker inspect --format '{{.Config.Image}}' "$previous_api_container")"
  previous_schema_compatibility="$(docker inspect --format '{{index .Config.Labels "com.aspb.schema.compatibility"}}' "$previous_api_container" 2>/dev/null || true)"
fi
if has_service webinar-worker; then
  previous_worker_container="$("${compose[@]}" ps -q webinar-worker 2>/dev/null || true)"
  if [[ -n "$previous_worker_container" ]]; then
    previous_worker_image_id="$(docker inspect --format '{{.Image}}' "$previous_worker_container")"
    previous_worker_image_ref="$(docker inspect --format '{{.Config.Image}}' "$previous_worker_container")"
  fi
fi

rollback_available=true
if [[ -z "$previous_api_image_id" || -z "$previous_api_image_ref" ]]; then
  rollback_available=false
fi
if has_service webinar-worker && [[ -z "$previous_worker_image_id" || -z "$previous_worker_image_ref" ]]; then
  rollback_available=false
fi
if [[ "$rollback_available" != "true" && "${ALLOW_DEPLOY_WITHOUT_ROLLBACK:-off}" != "on" ]]; then
  echo "No complete running-image rollback target was found." >&2
  echo "For a deliberate first deployment only, set ALLOW_DEPLOY_WITHOUT_ROLLBACK=on." >&2
  exit 1
fi

DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-backups/deploy-state}"
mkdir -p "$DEPLOY_STATE_DIR"
chmod 700 "$DEPLOY_STATE_DIR"
rollback_target_tmp="$(mktemp "$DEPLOY_STATE_DIR/.rollback-target.XXXXXX")"
{
  printf 'captured_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'deploying_commit=%s\n' "$DEPLOY_COMMIT_SHA"
  printf 'compose_file=%s\n' "$COMPOSE_FILE"
  printf 'verified_backup=%s\n' "${verified_backup:-operator-override}"
  printf 'verified_ci_run=%s\n' "$verified_ci_run_url"
  printf 'api_image_id=%s\n' "${previous_api_image_id:-unavailable}"
  printf 'api_image_ref=%s\n' "${previous_api_image_ref:-unavailable}"
  printf 'worker_image_id=%s\n' "${previous_worker_image_id:-unavailable}"
  printf 'worker_image_ref=%s\n' "${previous_worker_image_ref:-unavailable}"
  printf 'schema_compatibility=%s\n' "${previous_schema_compatibility:-legacy-or-missing}"
} >"$rollback_target_tmp"
mv "$rollback_target_tmp" "$DEPLOY_STATE_DIR/rollback-target.env"
chmod 600 "$DEPLOY_STATE_DIR/rollback-target.env"

container_health() {
  local container_id="$1"
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id"
}

wait_for_deployment_health() {
  local attempts="${1:-30}"
  local api_container worker_container api_health worker_health containers_present

  for _ in $(seq 1 "$attempts"); do
    api_container="$("${compose[@]}" ps -q api 2>/dev/null || true)"
    worker_container=""
    if has_service webinar-worker; then
      worker_container="$("${compose[@]}" ps -q webinar-worker 2>/dev/null || true)"
    fi

    containers_present=false
    if [[ -n "$api_container" ]]; then
      if ! has_service webinar-worker || [[ -n "$worker_container" ]]; then
        containers_present=true
      fi
    fi

    if [[ "$containers_present" == "true" ]]; then
      api_health="$(container_health "$api_container" 2>/dev/null || true)"
      worker_health="healthy"
      if [[ -n "$worker_container" ]]; then
        worker_health="$(container_health "$worker_container" 2>/dev/null || true)"
      fi
      if [[ "$api_health" == "healthy" && "$worker_health" == "healthy" ]]; then
        return 0
      fi
    fi
    sleep 4
  done
  return 1
}

release_replaced=false
api_quiesced=false
worker_quiesced=false
migration_started=false

wait_for_previous_container_health() {
  local container_id="$1"
  for _ in $(seq 1 30); do
    if [[ "$(container_health "$container_id" 2>/dev/null || true)" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

restart_quiesced_services() {
  if [[ "$api_quiesced" == "true" && -n "$previous_api_container" ]]; then
    echo "Restarting the previous API after a pre-migration deploy failure..." >&2
    docker start "$previous_api_container" >/dev/null
    if ! wait_for_previous_container_health "$previous_api_container"; then
      echo "Previous API did not become healthy after restart." >&2
      return 1
    fi
    api_quiesced=false
  fi

  if [[ "$worker_quiesced" == "true" && -n "$previous_worker_container" ]]; then
    echo "Restarting the previous webinar worker after a pre-migration deploy failure..." >&2
    docker start "$previous_worker_container" >/dev/null
    if ! wait_for_previous_container_health "$previous_worker_container"; then
      echo "Previous webinar worker did not become healthy after restart." >&2
      return 1
    fi
    worker_quiesced=false
  fi
  echo "Previous API/worker are healthy again." >&2
}

rollback_release() {
  if [[ "$rollback_available" != "true" ]]; then
    echo "Automatic rollback unavailable; target is documented in $DEPLOY_STATE_DIR/rollback-target.env" >&2
    return 1
  fi
  if ! may_restore_previous_release "$migration_started" "$previous_schema_compatibility"; then
    echo "Automatic rollback is prohibited: the previous image can write legacy plaintext bearer links after the applied migration." >&2
    return 1
  fi

  echo "Deployment failed after replacement; restoring previous image IDs..." >&2
  docker tag "$previous_api_image_id" "$previous_api_image_ref"
  # The reviewed compose files address images by DEPLOY_IMAGE_TAG. Retag the
  # old IDs to the failed release's refs as well, so rollback also works when
  # migrating from an older compose file that used different image names.
  docker tag "$previous_api_image_id" "aspb-autowebinar-api:$DEPLOY_IMAGE_TAG"
  if [[ -n "$previous_worker_image_id" && -n "$previous_worker_image_ref" ]]; then
    docker tag "$previous_worker_image_id" "$previous_worker_image_ref"
    docker tag "$previous_worker_image_id" "aspb-autowebinar-worker:$DEPLOY_IMAGE_TAG"
  fi

  if [[ "$previous_api_image_ref" == aspb-autowebinar-api:* ]]; then
    previous_image_tag="${previous_api_image_ref#aspb-autowebinar-api:}"
    if [[ -z "$previous_worker_image_ref" || "$previous_worker_image_ref" == "aspb-autowebinar-worker:$previous_image_tag" ]]; then
      export DEPLOY_IMAGE_TAG="$previous_image_tag"
    fi
  fi

  "${compose[@]}" up -d --no-build "${deploy_services[@]}"
  if wait_for_deployment_health 30; then
    echo "Automatic rollback restored healthy containers." >&2
    echo "Database migrations are forward-only and were not reverted." >&2
    return 0
  fi

  echo "Automatic rollback was attempted but the previous containers are not healthy." >&2
  "${compose[@]}" ps >&2 || true
  return 1
}

on_deploy_error() {
  local status=$?
  local service_restart_status=0
  local cleanup_protected_ids
  trap - ERR
  if [[ "$release_replaced" == "true" ]]; then
    set +e
    rollback_release
    local rollback_status=$?
    set -e
    if [[ "$rollback_status" -ne 0 ]]; then
      echo "Manual recovery is required; see $DEPLOY_STATE_DIR/rollback-target.env" >&2
    fi
  elif [[ "$api_quiesced" == "true" || "$worker_quiesced" == "true" ]]; then
    set +e
    if may_restore_previous_release "$migration_started" "$previous_schema_compatibility"; then
      restart_quiesced_services
      service_restart_status=$?
    else
      echo "Previous services remain stopped because migration started and their image is schema-incompatible." >&2
      service_restart_status=1
    fi
    set -e
    if [[ "$service_restart_status" -ne 0 ]]; then
      echo "Manual recovery with a schema-compatible image is required; see $DEPLOY_STATE_DIR/rollback-target.env" >&2
    fi
  fi

  set +e
  cleanup_protected_ids="$previous_api_image_id $previous_worker_image_id"
  if [[ "$migration_started" == "true" ]] && ! previous_release_is_schema_compatible "$previous_schema_compatibility"; then
    cleanup_protected_ids="$cleanup_protected_ids ${new_api_image_id:-} ${new_worker_image_id:-}"
  fi
  PROTECTED_IMAGE_IDS="$cleanup_protected_ids" \
    DEPLOY_STATE_DIR="$DEPLOY_STATE_DIR" \
    bash scripts/cleanup-failed-release-images.sh "$DEPLOY_COMMIT_SHA"
  set -e
  exit "$status"
}
trap on_deploy_error ERR

if ! DEPLOY_DATABASE_MODE="$deploy_database_mode" \
  DEPLOY_IMAGE_ARCHIVE="${DEPLOY_IMAGE_ARCHIVE:-}" \
  bash scripts/assert-deploy-capacity.sh; then
  echo "Low disk headroom: applying only targeted pre-deploy cleanup before retrying capacity check..." >&2
  DEPLOY_LOCK_HELD=on DEPLOY_STATE_DIR="$DEPLOY_STATE_DIR" bash scripts/prune-app-images.sh --apply
  if [[ "${DOCKER_BUILD_CACHE_PRUNE:-off}" == "on" ]]; then
    echo "WARNING: opt-in global BuildKit cache pruning affects every project on this Docker daemon." >&2
    docker builder prune -af --filter "until=${PREBUILD_CACHE_MAX_AGE:-24h}"
  fi
  DEPLOY_DATABASE_MODE="$deploy_database_mode" \
    DEPLOY_IMAGE_ARCHIVE="${DEPLOY_IMAGE_ARCHIVE:-}" \
    bash scripts/assert-deploy-capacity.sh
fi

if [[ "${DEPLOY_PREBUILT_IMAGES:-off}" != "on" ]]; then
  echo "Refusing deploy without the immutable, signed CI-built image artifact" >&2
  exit 1
fi
if [[ "${ALLOW_REMOTE_REBUILD:-off}" == "on" ]]; then
  echo "ALLOW_REMOTE_REBUILD is no longer supported; deploy provenance is fail-closed" >&2
  exit 1
fi
bash scripts/install-deploy-image.sh \
  "${DEPLOY_IMAGE_ARCHIVE:-}" \
  "${DEPLOY_IMAGE_CHECKSUM_FILE:-}" \
  "$DEPLOY_COMMIT_SHA"
verify_image_revision "$api_release_image"
new_api_image_id="$(docker image inspect --format '{{.Id}}' "$api_release_image")"
if has_service webinar-worker; then
  verify_image_revision "$worker_release_image"
  new_worker_image_id="$(docker image inspect --format '{{.Id}}' "$worker_release_image")"
fi

echo "Validating production environment before replacing containers..."
"${compose[@]}" run --rm --no-deps api \
  node --input-type=module -e "await import('./dist/src/lib/env.js')"
echo "Validating the configured production webinar media source..."
"${compose[@]}" run --rm --no-deps api node scripts/check-webinar-video.mjs

if has_service webinar-worker && [[ -n "$previous_worker_container" ]]; then
  echo "Quiescing the existing webinar worker before credential/token migrations..."
  worker_quiesced=true
  "${compose[@]}" stop -t "${WORKER_QUIESCE_TIMEOUT_SECONDS:-30}" webinar-worker
fi
if [[ -n "$previous_api_container" ]]; then
  echo "Quiescing the existing API before bearer-redaction migrations..."
  api_quiesced=true
  "${compose[@]}" stop -t "${API_QUIESCE_TIMEOUT_SECONDS:-30}" api
fi

echo "Applying forward-only database migrations..."
migration_started=true
"${compose[@]}" run --rm api npx prisma migrate deploy

echo "Starting deployment services..."
release_replaced=true
"${compose[@]}" up -d --no-build "${deploy_services[@]}"
verify_container_revision api
if has_service webinar-worker; then
  verify_container_revision webinar-worker
fi

if ! wait_for_deployment_health 30; then
  echo "Containers did not become healthy" >&2
  "${compose[@]}" ps >&2 || true
  "${compose[@]}" logs --tail 120 "${deploy_services[@]}" >&2 || true
  false
fi

allowed_dependency_statuses="200"
if [[ "${ALLOW_DEGRADED_DEPENDENCIES:-off}" == "on" ]]; then
  allowed_dependency_statuses="200,503"
  echo "WARNING: operator explicitly allowed degraded dependency status 503." >&2
fi

echo "Checking API dependencies and worker heartbeat..."
"${compose[@]}" exec -T -e DEPLOY_ALLOWED_DEPENDENCY_STATUSES="$allowed_dependency_statuses" api node -e '
  const allowed = new Set(
    String(process.env.DEPLOY_ALLOWED_DEPENDENCY_STATUSES || "200")
      .split(",")
      .map(value => Number(value)),
  );
  fetch(`http://127.0.0.1:${process.env.PORT || 5174}/health/dependencies/details`, {
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN || ""}` },
  })
    .then(async response => {
      await response.body?.cancel().catch(() => undefined);
      console.log(`Protected dependency health returned HTTP ${response.status}.`);
      if (!allowed.has(response.status)) process.exitCode = 1;
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
'
if has_service webinar-worker; then
  "${compose[@]}" exec -T webinar-worker node scripts/worker-healthcheck.mjs
else
  "${compose[@]}" exec -T api node scripts/worker-healthcheck.mjs
fi

current_release_tmp="$(mktemp "$DEPLOY_STATE_DIR/.current-release.XXXXXX")"
{
  printf 'deployed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'commit=%s\n' "$DEPLOY_COMMIT_SHA"
  printf 'compose_file=%s\n' "$COMPOSE_FILE"
  printf 'image_tag=%s\n' "$DEPLOY_IMAGE_TAG"
  printf 'image_revision=%s\n' "$DEPLOY_COMMIT_SHA"
  printf 'schema_compatibility=%s\n' "$ASPB_SCHEMA_COMPATIBILITY_VERSION"
  printf 'artifact_source=%s\n' "${DEPLOY_PREBUILT_IMAGES:-off}"
  printf 'api_image_id=%s\n' "$(docker image inspect --format '{{.Id}}' "$api_release_image")"
  if has_service webinar-worker; then
    printf 'worker_image_id=%s\n' "$(docker image inspect --format '{{.Id}}' "$worker_release_image")"
  fi
  printf 'verified_backup=%s\n' "${verified_backup:-operator-override}"
  printf 'verified_ci_run=%s\n' "$verified_ci_run_url"
} >"$current_release_tmp"
mv "$current_release_tmp" "$DEPLOY_STATE_DIR/current-release.env"
chmod 600 "$DEPLOY_STATE_DIR/current-release.env"

release_replaced=false
api_quiesced=false
worker_quiesced=false
trap - ERR
echo "Deployment health checks passed for exact commit $DEPLOY_COMMIT_SHA."

if [[ "${APP_IMAGE_PRUNE:-on}" == "on" ]]; then
  echo "Applying targeted application image retention (keeping ${APP_IMAGE_KEEP_RECENT:-3} recent per repository)..."
  if ! APP_IMAGE_KEEP_RECENT="${APP_IMAGE_KEEP_RECENT:-3}" \
    DEPLOY_STATE_DIR="$DEPLOY_STATE_DIR" \
    DEPLOY_LOCK_HELD=on \
    bash scripts/prune-app-images.sh --apply; then
    echo "WARNING: targeted application image retention failed after a healthy deployment." >&2
  fi
fi

if [[ "${DOCKER_BUILD_CACHE_PRUNE:-off}" == "on" ]]; then
  echo "WARNING: opt-in global BuildKit cache pruning affects every project on this Docker daemon."
  echo "Pruning unused Docker build cache older than ${DOCKER_BUILD_CACHE_MAX_AGE:-168h}..."
  if ! docker builder prune -af --filter "until=${DOCKER_BUILD_CACHE_MAX_AGE:-168h}"; then
    echo "WARNING: build-cache pruning failed after a healthy deployment." >&2
  fi
fi
