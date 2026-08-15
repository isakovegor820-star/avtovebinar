#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Deploy worktree check must run inside a Git repository" >&2
  exit 1
}
cd "$repo_root"

# Runtime output directories are excluded explicitly. Everything else,
# including untracked src/, prisma/migrations/ and frontend files, fails closed.
status="$(
  git status --porcelain=v1 --untracked-files=all -- . \
    ':(exclude)backups/**' \
    ':(exclude)test-results/**' \
    ':(exclude)playwright-report/**' \
    ':(exclude)blob-report/**' \
    ':(exclude)outputs/**'
)"

if [[ -n "$status" ]]; then
  echo "Refusing deploy from a worktree with tracked or untracked source changes:" >&2
  printf '%s\n' "$status" >&2
  exit 1
fi
