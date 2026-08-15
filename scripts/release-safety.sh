#!/usr/bin/env bash

# Shared, side-effect-free release invariants. This file is sourced by deploy
# and by CI regression checks.
ASPB_SCHEMA_COMPATIBILITY_VERSION="email-links-v2"

previous_release_is_schema_compatible() {
  [[ "${1:-}" == "$ASPB_SCHEMA_COMPATIBILITY_VERSION" ]]
}

may_restore_previous_release() {
  local migration_started="${1:-false}"
  local previous_compatibility="${2:-}"
  [[ "$migration_started" != "true" ]] || previous_release_is_schema_compatible "$previous_compatibility"
}

failed_release_cleanup_action() {
  local image_id="${1:-}"
  local protected_ids="${2:-}"
  local in_use="${3:-false}"
  local protected_id

  if [[ "$in_use" == "true" ]]; then
    printf 'keep\n'
    return 0
  fi
  for protected_id in $protected_ids; do
    if [[ "$protected_id" == "$image_id" ]]; then
      printf 'keep\n'
      return 0
    fi
  done
  printf 'remove\n'
}
