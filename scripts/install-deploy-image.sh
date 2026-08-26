#!/usr/bin/env bash

set -Eeuo pipefail

source scripts/release-safety.sh

for required_command in awk basename dirname docker sha256sum; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command for attested image installation: $required_command" >&2
    exit 1
  fi
done

archive="${1:-}"
checksum_file="${2:-}"
release_sha="${3:-}"
if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "install-deploy-image requires an exact 40-character release SHA" >&2
  exit 2
fi
artifact_dir="$(dirname -- "$archive")"
expected_archive_name="aspb-image-$release_sha.tar.gz"
if [[ "$(basename -- "$archive")" != "$expected_archive_name" || "$checksum_file" != "$archive.sha256" ]]; then
  echo "Deploy image artifacts must use exact-SHA archive/checksum names" >&2
  exit 2
fi
if [[ ! "$artifact_dir" =~ ^/tmp/aspb-deploy-[A-Za-z0-9._-]+$ || ! -d "$artifact_dir" || -L "$artifact_dir" ]]; then
  echo "Deploy image artifacts must be inside a real per-run /tmp/aspb-deploy-* directory" >&2
  exit 2
fi
if [[ ! -f "$archive" || -L "$archive" || ! -f "$checksum_file" || -L "$checksum_file" ]]; then
  echo "Deploy image archive/checksum is missing or is a symlink" >&2
  exit 1
fi

expected_checksum="$(awk 'NR == 1 { print $1 }' "$checksum_file")"
if [[ ! "$expected_checksum" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Deploy image checksum file is invalid" >&2
  exit 1
fi
actual_checksum="$(sha256sum "$archive" | awk '{ print $1 }')"
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  echo "Deploy image artifact checksum mismatch" >&2
  exit 1
fi

github_repository="${DEPLOY_GITHUB_REPOSITORY:-}"
source_ref="${DEPLOY_SOURCE_REF:-}"
if [[ ! "$github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "DEPLOY_GITHUB_REPOSITORY must be owner/repository" >&2
  exit 1
fi
if [[ ! "$source_ref" =~ ^refs/(heads|tags)/[A-Za-z0-9._/-]+$ || "$source_ref" == *".."* ]]; then
  echo "DEPLOY_SOURCE_REF must be a safe full Git ref" >&2
  exit 1
fi
attestation_cli="${DEPLOY_GH_BIN:-gh}"
attestation_bundle="${DEPLOY_ATTESTATION_BUNDLE:-}"
if [[ "$attestation_cli" != "gh" ]]; then
  if [[ "$attestation_cli" != "$artifact_dir/gh" || ! -f "$attestation_cli" || -L "$attestation_cli" || ! -x "$attestation_cli" ]]; then
    echo "DEPLOY_GH_BIN must be the executable non-symlink verifier in the per-run artifact directory" >&2
    exit 1
  fi
elif ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI with attestation support is required to verify deploy provenance" >&2
  exit 1
fi
if [[ -n "$attestation_bundle" ]]; then
  expected_bundle="$artifact_dir/aspb-image-$release_sha.attestation.jsonl"
  if [[ "$attestation_bundle" != "$expected_bundle" || ! -s "$attestation_bundle" || -L "$attestation_bundle" ]]; then
    echo "DEPLOY_ATTESTATION_BUNDLE must be the non-empty non-symlink exact-SHA bundle in the per-run artifact directory" >&2
    exit 1
  fi
elif [[ "$attestation_cli" != "gh" ]]; then
  echo "A scoped deploy verifier requires an offline DEPLOY_ATTESTATION_BUNDLE" >&2
  exit 1
fi

# The checksum protects transport pairing. The Sigstore/GitHub attestation is
# the non-forgeable source identity: exact archive bytes, repository, workflow,
# source commit and ref must all match before docker load can mutate local state.
attestation_verified=false
if [[ -n "$attestation_bundle" ]]; then
  if "$attestation_cli" attestation verify "$archive" \
    --bundle "$attestation_bundle" \
    --repo "$github_repository" \
    --signer-workflow "$github_repository/.github/workflows/ci.yml" \
    --source-digest "$release_sha" \
    --source-ref "$source_ref" \
    --deny-self-hosted-runners \
    >/dev/null; then
    attestation_verified=true
  fi
elif "$attestation_cli" attestation verify "$archive" \
  --repo "$github_repository" \
  --signer-workflow "$github_repository/.github/workflows/ci.yml" \
  --source-digest "$release_sha" \
  --source-ref "$source_ref" \
  --deny-self-hosted-runners \
  >/dev/null; then
  attestation_verified=true
fi
if [[ "$attestation_verified" != "true" ]]; then
  echo "Deploy image has no valid trusted GitHub build-provenance attestation" >&2
  exit 1
fi

build_ref="aspb-autowebinar-build:$release_sha"
docker load -i "$archive" >/dev/null
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$build_ref")"
compatibility="$(docker image inspect --format '{{index .Config.Labels "com.aspb.schema.compatibility"}}' "$build_ref")"
if [[ "$revision" != "$release_sha" || "$compatibility" != "$ASPB_SCHEMA_COMPATIBILITY_VERSION" ]]; then
  echo "Prebuilt deploy image provenance/schema compatibility is invalid" >&2
  exit 1
fi

docker tag "$build_ref" "aspb-autowebinar-api:$release_sha"
docker tag "$build_ref" "aspb-autowebinar-worker:$release_sha"
docker image rm "$build_ref" >/dev/null
rm -f -- "$archive" "$checksum_file"
if [[ -n "$attestation_bundle" ]]; then
  rm -f -- "$attestation_bundle"
fi
echo "Installed CI-built application image for exact commit $release_sha."
