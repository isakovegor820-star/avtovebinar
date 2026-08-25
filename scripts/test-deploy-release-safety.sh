#!/usr/bin/env bash

set -Eeuo pipefail

source scripts/release-safety.sh

legacy="legacy-or-missing"
current="$ASPB_SCHEMA_COMPATIBILITY_VERSION"
image_a="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
image_b="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

may_restore_previous_release false "$legacy"
if may_restore_previous_release true "$legacy"; then
  echo "Post-migration rollback accepted a schema-incompatible legacy image" >&2
  exit 1
fi
may_restore_previous_release true "$current"

test "$(failed_release_cleanup_action "$image_a" "$image_a" false)" = keep
test "$(failed_release_cleanup_action "$image_a" "$image_b" true)" = keep
test "$(failed_release_cleanup_action "$image_a" "$image_b" false)" = remove
grep -q 'aspb-autowebinar-build' scripts/cleanup-failed-release-images.sh

echo "Deploy release safety regression checks passed."
