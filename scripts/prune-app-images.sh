#!/usr/bin/env bash

set -Eeuo pipefail

mode="${1:---dry-run}"
case "$mode" in
  --dry-run) apply=false ;;
  --apply) apply=true ;;
  *)
    echo "Usage: bash scripts/prune-app-images.sh [--dry-run|--apply]" >&2
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "Missing required command: docker" >&2
  exit 1
fi

# Standalone runs serialize with deploy. The deploy script already owns this
# lock and passes DEPLOY_LOCK_HELD=on while retaining the inherited lock fd.
if [[ "${DEPLOY_LOCK_HELD:-off}" != "on" ]]; then
  if ! command -v flock >/dev/null 2>&1; then
    echo "Missing required command: flock" >&2
    exit 1
  fi
  DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/aspb-autowebinar-deploy.lock}"
  exec 8>"$DEPLOY_LOCK_FILE"
  if ! flock -n 8; then
    echo "Refusing image retention while another deployment is running" >&2
    exit 75
  fi
fi

APP_IMAGE_KEEP_RECENT="${APP_IMAGE_KEEP_RECENT:-3}"
if [[ ! "$APP_IMAGE_KEEP_RECENT" =~ ^[1-9][0-9]*$ ]] || (( APP_IMAGE_KEEP_RECENT > 20 )); then
  echo "APP_IMAGE_KEEP_RECENT must be an integer between 1 and 20" >&2
  exit 1
fi

DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-backups/deploy-state}"
repositories=(aspb-autowebinar-api aspb-autowebinar-worker)
container_names=(aspb-autowebinar-api aspb-autowebinar-worker)
keep_ids=()

valid_image_id() {
  [[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]]
}

id_is_kept() {
  local expected="$1" existing
  for existing in "${keep_ids[@]:-}"; do
    [[ "$existing" == "$expected" ]] && return 0
  done
  return 1
}

add_keep_id() {
  local image_id="$1"
  valid_image_id "$image_id" || return 0
  id_is_kept "$image_id" || keep_ids+=("$image_id")
}

# Running deployment containers are always protected, regardless of tags.
for container_name in "${container_names[@]}"; do
  add_keep_id "$(docker inspect --format '{{.Image}}' "$container_name" 2>/dev/null || true)"
done

# The previous release captured before deploy remains a valid rollback target.
rollback_state="$DEPLOY_STATE_DIR/rollback-target.env"
if [[ -f "$rollback_state" && ! -L "$rollback_state" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      api_image_id|worker_image_id) add_keep_id "$value" ;;
    esac
  done <"$rollback_state"
fi

# Keep N newest unique image IDs for each exact application repository.
for repository in "${repositories[@]}"; do
  recent_count=0
  recent_ids=()
  repository_image_ids="$(docker image ls "$repository" --all --no-trunc --format '{{.ID}}')"
  while IFS= read -r image_id; do
    valid_image_id "$image_id" || continue
    already_recent=false
    for recent_id in "${recent_ids[@]:-}"; do
      if [[ "$recent_id" == "$image_id" ]]; then
        already_recent=true
        break
      fi
    done
    [[ "$already_recent" == "true" ]] && continue
    recent_ids+=("$image_id")
    add_keep_id "$image_id"
    recent_count=$((recent_count + 1))
    (( recent_count >= APP_IMAGE_KEEP_RECENT )) && break
  done <<<"$repository_image_ids"
done

image_is_used_by_container() {
  local containers
  if ! containers="$(docker ps -aq --no-trunc --filter "ancestor=$1")"; then
    echo "Could not verify container usage for $1; keeping image" >&2
    return 0
  fi
  [[ -n "$containers" ]]
}

remove_target() {
  local target="$1" image_id="$2"
  if id_is_kept "$image_id"; then
    echo "KEEP $target ($image_id): current, rollback, or recent"
    return 0
  fi
  if image_is_used_by_container "$image_id"; then
    echo "KEEP $target ($image_id): used by a container"
    return 0
  fi

  if [[ "$apply" == "true" ]]; then
    echo "REMOVE $target ($image_id)"
    docker image rm "$target"
  else
    echo "DRY-RUN remove $target ($image_id)"
  fi
}

# Remove only tags returned from the two exact allowlisted repositories.
for repository in "${repositories[@]}"; do
  repository_refs="$(docker image ls "$repository" --all --no-trunc --format '{{.Repository}}:{{.Tag}}|{{.ID}}')"
  while IFS='|' read -r reference image_id; do
    [[ "$reference" == "$repository:"* ]] || continue
    [[ "$reference" == *':<none>' ]] && continue
    valid_image_id "$image_id" || continue
    remove_target "$reference" "$image_id"
  done <<<"$repository_refs"
done

# New builds carry an application label. This removes only old untagged images
# with that exact label; legacy/unrelated dangling images are intentionally left.
dangling_image_ids="$(
  docker image ls --all --no-trunc \
    --filter label=com.aspb.image.scope=autowebinar \
    --filter dangling=true \
    --format '{{.ID}}'
)"
while IFS= read -r image_id; do
  valid_image_id "$image_id" || continue
  remove_target "$image_id" "$image_id"
done <<<"$dangling_image_ids"

if [[ "$apply" == "true" ]]; then
  echo "Targeted АСПБ application image retention completed. Volumes and unrelated images were not touched."
else
  echo "Dry run completed. Re-run with --apply to remove only the listed application images."
fi
