#!/usr/bin/env bash

set -Eeuo pipefail

release_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
artifact_dir="/tmp/aspb-deploy-attestation-test.$$"
mock_bin="$(mktemp -d)"
docker_log="$mock_bin/docker.log"
cleanup() {
  rm -rf -- "$artifact_dir" "$mock_bin"
}
trap cleanup EXIT
mkdir -m 700 "$artifact_dir"
archive="$artifact_dir/aspb-image-$release_sha.tar.gz"
checksum="$archive.sha256"
printf 'fake archive\n' >"$archive"
printf '%064d  %s\n' 0 "$(basename -- "$archive")" | tr '0' 'a' >"$checksum"

# Mocks live outside the repository and only observe whether a failed
# attestation can reach docker load.
printf '%s\n' '#!/usr/bin/env bash' "printf '%064d  %s\\n' 0 \"\$1\" | tr 0 a" >"$mock_bin/sha256sum"
printf '%s\n' '#!/usr/bin/env bash' 'exit "${MOCK_GH_STATUS:-1}"' >"$mock_bin/gh"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "%s\n" "$*" >>"$MOCK_DOCKER_LOG"' \
  'if [[ "$1 $2" == "image inspect" ]]; then' \
  '  if [[ "$4" == *revision* ]]; then printf "%s\n" "$MOCK_RELEASE_SHA"; else printf "%s\n" email-links-v2; fi' \
  'fi' \
  'exit 0' >"$mock_bin/docker"
chmod 700 "$mock_bin/sha256sum" "$mock_bin/gh" "$mock_bin/docker"

common_env=(
  PATH="$mock_bin:$PATH"
  DEPLOY_GITHUB_REPOSITORY=example/aspb
  DEPLOY_SOURCE_REF=refs/heads/main
  MOCK_DOCKER_LOG="$docker_log"
  MOCK_RELEASE_SHA="$release_sha"
)
if env "${common_env[@]}" MOCK_GH_STATUS=1 \
  bash scripts/install-deploy-image.sh "$archive" "$checksum" "$release_sha" >/dev/null 2>&1; then
  echo "Unsigned deploy artifact was accepted" >&2
  exit 1
fi
if [[ -e "$docker_log" ]]; then
  echo "docker was mutated before attestation verification" >&2
  exit 1
fi
if env "${common_env[@]}" MOCK_GH_STATUS=0 DEPLOY_GH_BIN="$mock_bin/gh" \
  bash scripts/install-deploy-image.sh "$archive" "$checksum" "$release_sha" >/dev/null 2>&1; then
  echo "Out-of-directory deploy verifier was accepted" >&2
  exit 1
fi

env "${common_env[@]}" MOCK_GH_STATUS=0 \
  bash scripts/install-deploy-image.sh "$archive" "$checksum" "$release_sha" >/dev/null
grep -q '^load -i ' "$docker_log"
test ! -e "$archive"
test ! -e "$checksum"

rm -f -- "$docker_log"
cp "$mock_bin/gh" "$artifact_dir/gh"
printf 'fake archive\n' >"$archive"
printf '%064d  %s\n' 0 "$(basename -- "$archive")" | tr '0' 'a' >"$checksum"
bundle="$artifact_dir/aspb-image-$release_sha.attestation.jsonl"
printf '{}\n' >"$bundle"
env "${common_env[@]}" MOCK_GH_STATUS=0 DEPLOY_GH_BIN="$artifact_dir/gh" DEPLOY_ATTESTATION_BUNDLE="$bundle" \
  bash scripts/install-deploy-image.sh "$archive" "$checksum" "$release_sha" >/dev/null
grep -q '^load -i ' "$docker_log"
test ! -e "$archive"
test ! -e "$checksum"
test ! -e "$bundle"

echo "Deploy artifact attestation gate regression checks passed."
