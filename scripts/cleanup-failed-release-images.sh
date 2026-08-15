#!/usr/bin/env bash

set -Eeuo pipefail

source scripts/release-safety.sh

release_sha="${1:-}"
if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "cleanup-failed-release-images requires an exact 40-character release SHA" >&2
  exit 2
fi

docker_bin="${DOCKER_BIN:-docker}"
protected_ids="${PROTECTED_IMAGE_IDS:-}"
rollback_state="${DEPLOY_STATE_DIR:-backups/deploy-state}/rollback-target.env"

valid_image_id() {
  [[ "${1:-}" =~ ^sha256:[a-f0-9]{64}$ ]]
}

add_protected_id() {
  local image_id="${1:-}"
  valid_image_id "$image_id" || return 0
  protected_ids="${protected_ids:+$protected_ids }$image_id"
}

for container_name in aspb-autowebinar-api aspb-autowebinar-worker; do
  add_protected_id "$("$docker_bin" inspect --format '{{.Image}}' "$container_name" 2>/dev/null || true)"
done

if [[ -f "$rollback_state" && ! -L "$rollback_state" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      api_image_id|worker_image_id) add_protected_id "$value" ;;
    esac
  done <"$rollback_state"
fi

# install-deploy-image loads the CI artifact under the exact build ref before
# validating its labels. Include that bounded ref so a malformed/failed
# artifact cannot leak one image on every deploy attempt.
for repository in aspb-autowebinar-api aspb-autowebinar-worker aspb-autowebinar-build; do
  reference="$repository:$release_sha"
  image_id="$("$docker_bin" image inspect --format '{{.Id}}' "$reference" 2>/dev/null || true)"
  valid_image_id "$image_id" || continue
  containers="$("$docker_bin" ps -aq --no-trunc --filter "ancestor=$image_id" 2>/dev/null || true)"
  in_use=false
  [[ -n "$containers" ]] && in_use=true
  action="$(failed_release_cleanup_action "$image_id" "$protected_ids" "$in_use")"
  if [[ "$action" == "remove" ]]; then
    echo "Removing failed release ref $reference"
    "$docker_bin" image rm "$reference"
  else
    echo "Keeping failed release ref $reference because its image is current, rollback-protected, or in use"
  fi
done
