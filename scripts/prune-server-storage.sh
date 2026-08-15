#!/usr/bin/env bash

set -Eeuo pipefail

mode="${1:-}"
case "$mode" in
  --dry-run) apply=false ;;
  --apply) apply=true ;;
  *)
    echo "Usage: bash scripts/prune-server-storage.sh [--dry-run|--apply]" >&2
    exit 2
    ;;
esac

for required_command in find flock realpath sort awk; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

PRUNE_LOCK_FILE="${COMPLIANCE_PRUNE_LOCK_FILE:-/run/lock/prune-compliance152-releases.lock}"
if [[ "$PRUNE_LOCK_FILE" != /* ]]; then
  echo "COMPLIANCE_PRUNE_LOCK_FILE must be absolute" >&2
  exit 1
fi
exec 9>"$PRUNE_LOCK_FILE"
if ! flock -n 9; then
  echo "Release retention: another run is already active."
  exit 0
fi

DEFAULT_RELEASE_ROOT=/opt/compliance152-releases
RELEASE_ROOT="${COMPLIANCE_RELEASE_ROOT:-$DEFAULT_RELEASE_ROOT}"
CURRENT_LINK="${COMPLIANCE_CURRENT_LINK:-/opt/compliance152-current}"
KEEP_RELEASES="${COMPLIANCE_KEEP_RELEASES:-5}"
ROOT_MARKER_NAME=.compliance152-release-root
ROOT_MARKER_VALUE=compliance152-release-root-v1

if [[ ! "$KEEP_RELEASES" =~ ^[0-9]+$ ]] || (( KEEP_RELEASES < 2 || KEEP_RELEASES > 100 )); then
  echo "COMPLIANCE_KEEP_RELEASES must be an integer between 2 and 100" >&2
  exit 1
fi

release_root_real="$(realpath -e -- "$RELEASE_ROOT")"
case "$release_root_real" in
  /|/opt|/var|/srv|/home|/root|/Users|/tmp|/private|/private/tmp)
    echo "Refusing dangerously broad release root: $release_root_real" >&2
    exit 1
    ;;
esac

# Production defaults to one exact root. Tests or a deliberate relocation must
# add the exact canonical path to an explicit colon-separated allowlist; broad
# roots above remain forbidden even if an operator puts them in the allowlist.
allowed=false
IFS=':' read -r -a allowed_roots <<<"${COMPLIANCE_RELEASE_ROOT_ALLOWLIST:-$DEFAULT_RELEASE_ROOT}"
for allowed_root in "${allowed_roots[@]}"; do
  [[ -n "$allowed_root" ]] || continue
  if [[ "$(realpath -m -- "$allowed_root")" == "$release_root_real" ]]; then
    allowed=true
    break
  fi
done
if [[ "$allowed" != "true" ]]; then
  echo "Release root is not in COMPLIANCE_RELEASE_ROOT_ALLOWLIST: $release_root_real" >&2
  exit 1
fi

root_marker="$release_root_real/$ROOT_MARKER_NAME"
if [[ ! -f "$root_marker" || -L "$root_marker" || "$(tr -d '\r\n' <"$root_marker")" != "$ROOT_MARKER_VALUE" ]]; then
  echo "Refusing retention without exact root marker $root_marker" >&2
  exit 1
fi
if [[ ! -L "$CURRENT_LINK" ]]; then
  echo "COMPLIANCE_CURRENT_LINK must be a symlink to an active release" >&2
  exit 1
fi
active_release="$(realpath -e -- "$CURRENT_LINK")"
if [[ "$(dirname -- "$active_release")" != "$release_root_real" || ! -d "$active_release" ]]; then
  echo "Active release must resolve to one direct child of $release_root_real" >&2
  exit 1
fi

mapfile -t releases < <(
  find "$release_root_real" -mindepth 1 -maxdepth 1 -type d \
    -printf '%T@ %f\n' | sort -n | awk '{print $2}'
)
non_active_releases=()
for name in "${releases[@]}"; do
  if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "Refusing unexpected release directory name: $name" >&2
    exit 1
  fi
  release_path="$(realpath -e -- "$release_root_real/$name")"
  if [[ "$(dirname -- "$release_path")" != "$release_root_real" ]]; then
    echo "Refusing release outside root: $release_path" >&2
    exit 1
  fi
  if [[ "$release_path" != "$active_release" ]]; then
    non_active_releases+=("$name")
  fi
done

delete_count=$((${#non_active_releases[@]} - KEEP_RELEASES))
if (( delete_count <= 0 )); then
  echo "Release retention: nothing to prune (${#non_active_releases[@]} inactive <= $KEEP_RELEASES)."
  exit 0
fi

for ((i = 0; i < delete_count; i++)); do
  name="${non_active_releases[$i]}"
  release_path="$(realpath -e -- "$release_root_real/$name")"
  if [[ "$(dirname -- "$release_path")" != "$release_root_real" || "$release_path" == "$active_release" ]]; then
    echo "Refusing unsafe release target: $release_path" >&2
    exit 1
  fi
  if [[ "$apply" == "true" ]]; then
    echo "Removing expired release: $release_path"
    rm -rf --one-file-system -- "$release_path"
  else
    echo "DRY-RUN remove expired release: $release_path"
  fi
done
