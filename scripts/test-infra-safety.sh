#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT

release_root="$test_root/compliance152-releases"
current_link="$test_root/compliance152-current"
lock_file="$test_root/prune.lock"
mkdir -p "$release_root"

if COMPLIANCE_RELEASE_ROOT=/ \
  COMPLIANCE_RELEASE_ROOT_ALLOWLIST=/ \
  COMPLIANCE_CURRENT_LINK="$current_link" \
  COMPLIANCE_PRUNE_LOCK_FILE="$lock_file" \
  bash scripts/prune-server-storage.sh --dry-run >/dev/null 2>&1; then
  echo "Broad release root was accepted" >&2
  exit 1
fi

mkdir -p "$release_root/r1"
ln -s "$release_root/r1" "$current_link"
if COMPLIANCE_RELEASE_ROOT="$release_root" \
  COMPLIANCE_RELEASE_ROOT_ALLOWLIST="$release_root" \
  COMPLIANCE_CURRENT_LINK="$current_link" \
  COMPLIANCE_PRUNE_LOCK_FILE="$lock_file" \
  bash scripts/prune-server-storage.sh --dry-run >/dev/null 2>&1; then
  echo "Release root without marker was accepted" >&2
  exit 1
fi

printf '%s\n' compliance152-release-root-v1 >"$release_root/.compliance152-release-root"
for index in 2 3 4 5 6 7; do
  mkdir -p "$release_root/r$index"
  touch -t "2026010${index}0000" "$release_root/r$index"
done
touch -t 202601010000 "$release_root/r1"

common_env=(
  COMPLIANCE_RELEASE_ROOT="$release_root"
  COMPLIANCE_RELEASE_ROOT_ALLOWLIST="$release_root"
  COMPLIANCE_CURRENT_LINK="$current_link"
  COMPLIANCE_KEEP_RELEASES=2
  COMPLIANCE_PRUNE_LOCK_FILE="$lock_file"
)
dry_run_output="$(env "${common_env[@]}" bash scripts/prune-server-storage.sh --dry-run)"
grep -q 'DRY-RUN remove expired release' <<<"$dry_run_output"
test -d "$release_root/r2"

env "${common_env[@]}" bash scripts/prune-server-storage.sh --apply >/dev/null
test -d "$release_root/r1"
test -d "$release_root/r6"
test -d "$release_root/r7"
test ! -e "$release_root/r2"
test ! -e "$release_root/r3"
test ! -e "$release_root/r4"
test ! -e "$release_root/r5"

capacity_mock_bin="$test_root/capacity-bin"
mkdir -p "$capacity_mock_bin"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$MOCK_DOCKER_ROOT"' >"$capacity_mock_bin/docker"
chmod 700 "$capacity_mock_bin/docker"
capacity_artifact="$test_root/aspb-image-test.tar.gz"
printf 'bounded artifact\n' >"$capacity_artifact"
capacity_env=(
  PATH="$capacity_mock_bin:$PATH"
  MOCK_DOCKER_ROOT="$test_root"
  DEPLOY_IMAGE_ARCHIVE="$capacity_artifact"
  DEPLOY_PREBUILT_IMAGES=on
  MIN_DEPLOY_FREE_PERCENT=1
  DEPLOY_ARTIFACT_EXPANSION_FACTOR=1
  DEPLOY_ARTIFACT_UNPACK_RESERVE_BYTES=1
  MIN_DEPLOY_ARTIFACT_FS_FREE_BYTES=1
  MIN_DEPLOY_ARTIFACT_FS_FREE_PERCENT=1
)
env "${capacity_env[@]}" MIN_DEPLOY_FREE_BYTES=1 \
  bash scripts/assert-deploy-capacity.sh >/dev/null
if env "${capacity_env[@]}" MIN_DEPLOY_FREE_BYTES=1 DEPLOY_DATABASE_MODE=native \
  bash scripts/assert-deploy-capacity.sh >/dev/null 2>&1; then
  echo "Native PostgreSQL capacity gate accepted a missing storage path" >&2
  exit 1
fi
env "${capacity_env[@]}" MIN_DEPLOY_FREE_BYTES=1 DEPLOY_DATABASE_MODE=native \
  NATIVE_POSTGRES_STORAGE_PATH="$test_root" \
  MIN_POSTGRES_MIGRATION_FREE_BYTES=1 MIN_POSTGRES_MIGRATION_FREE_PERCENT=1 \
  bash scripts/assert-deploy-capacity.sh >/dev/null
if env "${capacity_env[@]}" MIN_DEPLOY_FREE_BYTES=999999999999999999 \
  bash scripts/assert-deploy-capacity.sh >/dev/null 2>&1; then
  echo "Capacity gate accepted impossible Docker headroom" >&2
  exit 1
fi

grep -q 'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6' .github/workflows/ci.yml
grep -q 'gh_2.98.0_linux_amd64.tar.gz' .github/workflows/ci.yml
grep -q 'DEPLOY_GH_BIN="$attestation_cli"' .github/workflows/ci.yml
grep -q 'DEPLOY_ATTESTATION_BUNDLE="$attestation_bundle"' .github/workflows/ci.yml
grep -q 'gh attestation download "$archive"' .github/workflows/ci.yml
grep -q -- '--source-digest "$release_sha"' scripts/install-deploy-image.sh
grep -q -- '--deny-self-hosted-runners' scripts/install-deploy-image.sh
grep -q 'DEPLOY_LOCK_HELD=on' .github/workflows/ci.yml
grep -q 'STAGING_NATIVE_POSTGRES_STORAGE_PATH' .github/workflows/ci.yml
grep -q 'PRODUCTION_NATIVE_POSTGRES_STORAGE_PATH' .github/workflows/ci.yml
if grep -q 'operator explicitly allowed deploy without exact-commit CI attestation' scripts/deploy-production.sh; then
  echo "Unsigned CI-attestation bypass returned" >&2
  exit 1
fi
if grep -q '\${DOCKER_BUILD_CACHE_PRUNE:-on}' scripts/deploy-production.sh; then
  echo "Global BuildKit cleanup became default-on" >&2
  exit 1
fi

echo "Infrastructure safety regression checks passed."
