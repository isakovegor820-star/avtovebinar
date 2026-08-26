#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const deploy = readFileSync('scripts/deploy-production.sh', 'utf8');
const installImage = readFileSync('scripts/install-deploy-image.sh', 'utf8');
const capacity = readFileSync('scripts/assert-deploy-capacity.sh', 'utf8');
const compliancePrune = readFileSync('scripts/prune-server-storage.sh', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');
const productionCompose = readFileSync('docker-compose.production.yml', 'utf8');
const nativeCompose = readFileSync('docker-compose.native-postgres.yml', 'utf8');

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`CI/deploy contract missing ${label}`);
}

function requireAbsent(source, forbidden, label) {
  if (source.includes(forbidden)) throw new Error(`CI/deploy contract still permits ${label}`);
}

requireText(
  workflow,
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'pinned immutable image upload',
);
requireText(
  workflow,
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  'pinned immutable image download',
);
requireText(workflow, 'docker save -o "$artifact" "$build_ref"', 'Docker image export');
requireText(workflow, 'sha256sum "aspb-image-$GITHUB_SHA.tar.gz"', 'artifact checksum');
requireText(workflow, 'DEPLOY_PREBUILT_IMAGES=on', 'prebuilt deploy mode');
requireText(workflow, 'DEPLOY_IMAGE_ARCHIVE="$image_archive"', 'remote archive path');
requireText(workflow, 'DEPLOY_IMAGE_CHECKSUM_FILE="$image_checksum"', 'remote checksum path');
requireText(
  workflow,
  'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
  'pinned GitHub build-provenance attestation',
);
requireText(workflow, 'artifact-metadata: write', 'attestation permissions');
requireText(workflow, 'attestations: read', 'offline attestation bundle read permission');
requireText(workflow, 'gh attestation download "$archive"', 'offline attestation bundle download');
requireText(workflow, 'DEPLOY_ATTESTATION_BUNDLE="$attestation_bundle"', 'offline bundle propagation');
requireText(workflow, 'gh_2.98.0_linux_amd64.tar.gz', 'pinned remote attestation verifier');
requireText(
  workflow,
  '3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de',
  'pinned remote attestation verifier checksum',
);
requireText(workflow, 'DEPLOY_GH_BIN="$attestation_cli"', 'per-run attestation verifier propagation');
requireText(workflow, 'secretlint@13.0.4', 'pinned secret scanner CLI');
requireText(workflow, 'dotenv-linter@0.2.0', 'pinned dotenv scanner CLI');
requireText(
  workflow,
  "inputs.deploy_target == 'staging' || inputs.deploy_target == 'production'",
  'staging-before-production',
);
requireText(
  workflow,
  "(github.event_name == 'push' && github.ref == 'refs/heads/main') ||",
  'automatic production deploy from main',
);
requireText(workflow, 'container-build, deploy-staging]', 'production dependency on successful staging');
requireText(workflow, 'Staging deploy configuration is incomplete', 'fail-closed staging configuration');
requireText(workflow, '/tmp/aspb-deploy-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-staging', 'per-run staging artifact path');
requireText(
  workflow,
  '/tmp/aspb-deploy-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-production',
  'per-run production artifact path',
);
requireText(workflow, 'DEPLOY_LOCK_HELD=on', 'checkout covered by inherited deploy lock');
requireText(workflow, 'STAGING_NATIVE_POSTGRES_STORAGE_PATH', 'staging native PostgreSQL capacity path');
requireText(workflow, 'COMPOSE_PROJECT_NAME=aspb-platform-staging', 'isolated staging Compose project');
requireText(workflow, 'ASPB_CONTAINER_PREFIX=aspb-platform-staging', 'isolated staging container namespace');
requireText(workflow, 'ASPB_BIND_PORT=5176', 'isolated staging bind port');
requireText(workflow, 'STAGING public origin isolation is not provisioned', 'isolated staging public origin');
requireText(workflow, 'STAGING database isolation is not provisioned', 'isolated staging database');
requireText(workflow, 'staging_env_file=.env.staging', 'separate staging environment file');
requireText(workflow, 'BACKUP_DIR=backups/staging', 'separate staging backup directory');
requireText(workflow, 'ALLOW_DEGRADED_DEPENDENCIES=on', 'isolated staging degraded integrations');
requireText(workflow, 'PRODUCTION_NATIVE_POSTGRES_STORAGE_PATH', 'production native PostgreSQL capacity path');
requireText(
  workflow,
  'Recovered production environment from the running API container.',
  'one-time production environment recovery',
);
requireText(workflow, '--filter publish=5174', 'production API recovery port isolation');
requireText(workflow, 'PRODUCTION origin/database isolation is not provisioned', 'production environment isolation');
requireText(
  workflow,
  'NATIVE_POSTGRES_STORAGE_PATH="$native_postgres_storage_path"',
  'remote native PostgreSQL capacity path propagation',
);
requireText(workflow, 'allow_first_deploy:', 'explicit first-deploy workflow input');
requireText(
  workflow,
  'ALLOW_DEPLOY_WITHOUT_ROLLBACK="$allow_first_deploy"',
  'reviewed first-deploy rollback override propagation',
);
requireText(deploy, 'bash scripts/install-deploy-image.sh', 'verified image installation');
requireText(deploy, 'if [[ "$deploy_environment" == "production" ]]', 'production-only private media probe');
requireText(deploy, 'node scripts/check-webinar-video.mjs', 'production webinar media validation');
requireText(deploy, 'ALLOW_REMOTE_REBUILD is no longer supported', 'fail-closed remote rebuild gate');
requireText(deploy, 'ALLOW_DEPLOY_WITHOUT_CI_ATTESTATION is no longer supported', 'removed unsigned deploy bypass');
requireText(installImage, '"$attestation_cli" attestation verify "$archive"', 'cryptographic artifact verification');
requireText(installImage, 'DEPLOY_GH_BIN', 'scoped remote attestation verifier');
requireText(installImage, 'DEPLOY_ATTESTATION_BUNDLE', 'offline remote attestation bundle');
requireText(installImage, '--bundle "$attestation_bundle"', 'offline bundle verification');
requireText(installImage, '--source-digest "$release_sha"', 'attested exact source commit');
requireText(installImage, '--signer-workflow "$github_repository/.github/workflows/ci.yml"', 'trusted signer workflow');
requireText(installImage, '--deny-self-hosted-runners', 'GitHub-hosted attestation builder');
requireText(capacity, "docker info --format '{{.DockerRootDir}}'", 'actual DockerRootDir capacity');
requireText(capacity, 'DEPLOY_ARTIFACT_EXPANSION_FACTOR', 'artifact-size-aware capacity');
requireText(
  capacity,
  'NATIVE_POSTGRES_STORAGE_PATH is mandatory for a native PostgreSQL deploy',
  'fail-closed native PostgreSQL capacity',
);
requireText(deploy, 'DEPLOY_DATABASE_MODE="$deploy_database_mode"', 'compose-selected database capacity mode');
requireText(compliancePrune, 'compliance152-release-root-v1', 'destructive-prune root marker');
requireText(compliancePrune, 'Refusing dangerously broad release root', 'broad-root refusal');
requireAbsent(deploy, '${DOCKER_BUILD_CACHE_PRUNE:-on}', 'default-on global BuildKit cleanup');
requireText(dockerfile, 'node:22-alpine@sha256:', 'pinned Node base image');
requireText(dockerfile, 'org.opencontainers.image.revision', 'OCI revision label');
requireText(dockerfile, 'com.aspb.schema.compatibility="email-links-v2"', 'schema compatibility label');
for (const [name, compose] of [
  ['docker-compose.production.yml', productionCompose],
  ['docker-compose.native-postgres.yml', nativeCompose],
]) {
  const count = compose.split('BUILD_COMMIT_SHA: ${DEPLOY_COMMIT_SHA:-local}').length - 1;
  if (count !== 2) throw new Error(`${name} must pass BUILD_COMMIT_SHA to exactly two application services`);
}
requireText(
  nativeCompose,
  'container_name: ${ASPB_CONTAINER_PREFIX:-aspb-autowebinar}-api',
  'configurable native API container name',
);
requireText(
  nativeCompose,
  'container_name: ${ASPB_CONTAINER_PREFIX:-aspb-autowebinar}-worker',
  'configurable native worker container name',
);
requireText(nativeCompose, '127.0.0.1:${ASPB_BIND_PORT:-5174}:5174', 'configurable native bind port');

console.log('CI immutable-image deploy contract is complete.');
