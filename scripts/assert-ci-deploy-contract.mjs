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
requireText(workflow, 'secretlint@13.0.4', 'pinned secret scanner CLI');
requireText(workflow, 'dotenv-linter@0.2.0', 'pinned dotenv scanner CLI');
requireText(
  workflow,
  "inputs.deploy_target == 'staging' || inputs.deploy_target == 'production'",
  'staging-before-production',
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
requireText(workflow, 'PRODUCTION_NATIVE_POSTGRES_STORAGE_PATH', 'production native PostgreSQL capacity path');
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
requireText(deploy, 'ALLOW_REMOTE_REBUILD is no longer supported', 'fail-closed remote rebuild gate');
requireText(deploy, 'ALLOW_DEPLOY_WITHOUT_CI_ATTESTATION is no longer supported', 'removed unsigned deploy bypass');
requireText(installImage, 'gh attestation verify "$archive"', 'cryptographic artifact verification');
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
requireText(workflow, 'node dist/src/cli/mediaAcceptance.js', 'real media acceptance in the production image');
requireText(workflow, 'Persistent media restart acceptance', 'persistent media restart gate');
requireText(workflow, 'MEDIA_ACCEPTANCE_RESTART=on', 'restart acceptance guard');
requireText(workflow, '"--restart-$phase"', 'two-process media resume command');
for (const [name, compose] of [
  ['docker-compose.production.yml', productionCompose],
  ['docker-compose.native-postgres.yml', nativeCompose],
]) {
  const count = compose.split('BUILD_COMMIT_SHA: ${DEPLOY_COMMIT_SHA:-local}').length - 1;
  if (count !== 2) throw new Error(`${name} must pass BUILD_COMMIT_SHA to exactly two application services`);
  requireText(
    compose,
    '${LEGACY_MEDIA_PATH:?LEGACY_MEDIA_PATH is required}:/app/crisis_premium/assets/media:ro',
    `${name} read-only legacy media compatibility mount`,
  );
}
requireText(deploy, 'LEGACY_MEDIA_PATH must be an existing absolute directory', 'legacy media directory validation');
requireText(deploy, 'LEGACY_MEDIA_PATH must be a dedicated directory', 'broad legacy media path refusal');

console.log('CI immutable-image deploy contract is complete.');
