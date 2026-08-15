#!/usr/bin/env bash

set -Eeuo pipefail

for required_command in awk df dirname docker realpath stat; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

positive_integer() {
  local value="$1" name="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer" >&2
    exit 2
  fi
}

percentage() {
  local value="$1" name="$2"
  positive_integer "$value" "$name"
  if (( value > 99 )); then
    echo "$name must be between 1 and 99" >&2
    exit 2
  fi
}

file_size_bytes() {
  local path="$1" size
  if size="$(stat -c %s "$path" 2>/dev/null)"; then
    :
  elif size="$(stat -f %z "$path" 2>/dev/null)"; then
    :
  else
    echo "Could not determine file size: $path" >&2
    return 1
  fi
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$size"
}

check_capacity() {
  local label="$1" path="$2" required_bytes="$3" required_percent="$4"
  local total_kb available_kb available_bytes available_percent
  if [[ ! -e "$path" ]]; then
    echo "$label capacity path does not exist: $path" >&2
    return 1
  fi
  read -r total_kb available_kb < <(df -Pk "$path" | awk 'NR == 2 { print $2, $4 }')
  if [[ ! "$total_kb" =~ ^[1-9][0-9]*$ || ! "$available_kb" =~ ^[0-9]+$ ]]; then
    echo "Could not determine $label capacity for $path" >&2
    return 1
  fi
  available_bytes="$((available_kb * 1024))"
  available_percent="$((available_kb * 100 / total_kb))"
  if (( available_bytes < required_bytes || available_percent < required_percent )); then
    echo "Insufficient $label headroom on $path: ${available_percent}% free (${available_bytes} bytes); require ${required_percent}% and ${required_bytes} bytes" >&2
    return 1
  fi
  echo "$label headroom is sufficient on $path: ${available_percent}% free (${available_bytes} bytes)."
}

min_free_bytes="${MIN_DEPLOY_FREE_BYTES:-3221225472}"
min_free_percent="${MIN_DEPLOY_FREE_PERCENT:-15}"
artifact_expansion_factor="${DEPLOY_ARTIFACT_EXPANSION_FACTOR:-6}"
artifact_unpack_reserve_bytes="${DEPLOY_ARTIFACT_UNPACK_RESERVE_BYTES:-1073741824}"
min_artifact_fs_free_bytes="${MIN_DEPLOY_ARTIFACT_FS_FREE_BYTES:-536870912}"
min_artifact_fs_free_percent="${MIN_DEPLOY_ARTIFACT_FS_FREE_PERCENT:-5}"
deploy_database_mode="${DEPLOY_DATABASE_MODE:-docker}"
positive_integer "$min_free_bytes" MIN_DEPLOY_FREE_BYTES
percentage "$min_free_percent" MIN_DEPLOY_FREE_PERCENT
positive_integer "$artifact_expansion_factor" DEPLOY_ARTIFACT_EXPANSION_FACTOR
if (( artifact_expansion_factor > 20 )); then
  echo "DEPLOY_ARTIFACT_EXPANSION_FACTOR must be at most 20" >&2
  exit 2
fi
positive_integer "$artifact_unpack_reserve_bytes" DEPLOY_ARTIFACT_UNPACK_RESERVE_BYTES
positive_integer "$min_artifact_fs_free_bytes" MIN_DEPLOY_ARTIFACT_FS_FREE_BYTES
percentage "$min_artifact_fs_free_percent" MIN_DEPLOY_ARTIFACT_FS_FREE_PERCENT
case "$deploy_database_mode" in
  docker|native) ;;
  *)
    echo "DEPLOY_DATABASE_MODE must be docker or native" >&2
    exit 2
    ;;
esac

docker_storage_path="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
if [[ -z "$docker_storage_path" || ! -d "$docker_storage_path" ]]; then
  echo "Could not resolve the active DockerRootDir from the Docker daemon" >&2
  exit 1
fi
if [[ -n "${DOCKER_STORAGE_PATH:-}" && "$(realpath -m -- "$DOCKER_STORAGE_PATH")" != "$(realpath -e -- "$docker_storage_path")" ]]; then
  echo "DOCKER_STORAGE_PATH does not match DockerRootDir reported by the active daemon" >&2
  exit 1
fi

docker_required_bytes="$min_free_bytes"
artifact="${DEPLOY_IMAGE_ARCHIVE:-}"
if [[ -n "$artifact" ]]; then
  if [[ ! -f "$artifact" || -L "$artifact" ]]; then
    echo "DEPLOY_IMAGE_ARCHIVE must be a regular non-symlink file for capacity calculation" >&2
    exit 1
  fi
  artifact_bytes="$(file_size_bytes "$artifact")"
  if [[ ! "$artifact_bytes" =~ ^[1-9][0-9]*$ || "$artifact_bytes" -gt 1099511627776 ]]; then
    echo "DEPLOY_IMAGE_ARCHIVE size is invalid or exceeds the 1 TiB safety bound" >&2
    exit 1
  fi
  artifact_required_bytes="$((artifact_bytes * artifact_expansion_factor + artifact_unpack_reserve_bytes))"
  if (( artifact_required_bytes > docker_required_bytes )); then
    docker_required_bytes="$artifact_required_bytes"
  fi
  check_capacity "/tmp deploy-artifact filesystem" "$(dirname -- "$artifact")" \
    "$min_artifact_fs_free_bytes" "$min_artifact_fs_free_percent"
elif [[ "${DEPLOY_PREBUILT_IMAGES:-off}" == "on" ]]; then
  echo "DEPLOY_IMAGE_ARCHIVE is required for a prebuilt-image capacity check" >&2
  exit 1
fi

check_capacity "Docker image storage" "$docker_storage_path" "$docker_required_bytes" "$min_free_percent"

if [[ "$deploy_database_mode" == "native" && -z "${NATIVE_POSTGRES_STORAGE_PATH:-}" ]]; then
  echo "NATIVE_POSTGRES_STORAGE_PATH is mandatory for a native PostgreSQL deploy" >&2
  exit 1
fi

if [[ -n "${NATIVE_POSTGRES_STORAGE_PATH:-}" ]]; then
  postgres_min_bytes="${MIN_POSTGRES_MIGRATION_FREE_BYTES:-1073741824}"
  postgres_min_percent="${MIN_POSTGRES_MIGRATION_FREE_PERCENT:-10}"
  positive_integer "$postgres_min_bytes" MIN_POSTGRES_MIGRATION_FREE_BYTES
  percentage "$postgres_min_percent" MIN_POSTGRES_MIGRATION_FREE_PERCENT
  if [[ "$NATIVE_POSTGRES_STORAGE_PATH" != /* || ! -d "$NATIVE_POSTGRES_STORAGE_PATH" ]]; then
    echo "NATIVE_POSTGRES_STORAGE_PATH must be an existing absolute directory: $NATIVE_POSTGRES_STORAGE_PATH" >&2
    exit 1
  fi
  check_capacity "native PostgreSQL storage" "$NATIVE_POSTGRES_STORAGE_PATH" \
    "$postgres_min_bytes" "$postgres_min_percent"
fi
