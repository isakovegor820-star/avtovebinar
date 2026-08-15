#!/usr/bin/env bash

set -Eeuo pipefail

env_file="${1:-}"
if [[ -z "$env_file" ]]; then
  echo "Usage: $0 <production-env-file>" >&2
  exit 2
fi
if [[ ! -f "$env_file" ]]; then
  echo "Production environment file not found: $env_file" >&2
  exit 1
fi
if [[ -L "$env_file" ]]; then
  echo "Refusing symlinked production environment file: $env_file" >&2
  exit 1
fi

env_file_mode=""
if env_file_mode="$(stat -c '%a' "$env_file" 2>/dev/null)"; then
  :
elif env_file_mode="$(stat -f '%Lp' "$env_file" 2>/dev/null)"; then
  :
else
  echo "Could not determine production environment file permissions: $env_file" >&2
  exit 1
fi

case "$env_file_mode" in
  400|600) ;;
  *)
    echo "Refusing insecure production environment file permissions: $env_file has mode $env_file_mode; expected 400 or 600" >&2
    exit 1
    ;;
esac
