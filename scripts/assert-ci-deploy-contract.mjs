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
const stagingSmoke = readFileSync('scripts/staging/smoke.mjs', 'utf8');

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
  'hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e',
  'pinned Terraform validator setup',
);
requireText(workflow, 'terraform_version: 1.15.9', 'pinned Terraform CLI version');
requireText(workflow, 'terraform fmt -check -recursive', 'Terraform formatting gate');
requireText(
  workflow,
  'terraform init -backend=false -input=false -lockfile=readonly',
  'backend-free locked Terraform initialization',
);
requireText(workflow, 'terraform validate', 'Terraform validation gate');
requireAbsent(workflow, 'terraform apply', 'Terraform apply in CI');
requireAbsent(workflow, 'tofu apply', 'OpenTofu apply in CI');
requireText(workflow, 'npx prisma format', 'Prisma formatting gate');
requireText(workflow, 'npx prisma validate', 'Prisma validation gate');
requireText(
  workflow,
  "inputs.deploy_target == 'staging' || inputs.deploy_target == 'production'",
  'staging-before-production',
);
requireText(workflow, 'dependency-audit, iac-validate, container-build]', 'staging dependency on IaC validation');
requireText(
  workflow,
  'dependency-audit, iac-validate, container-build, deploy-staging, staging-smoke]',
  'production dependency on IaC validation and successful staging smoke',
);
requireText(stagingSmoke, "for (const pathname of ['/health', '/health/ready'])", 'dependency-aware staging smoke');
requireText(workflow, 'Staging deploy configuration is incomplete', 'fail-closed staging configuration');
requireText(workflow, "inputs.deploy_target == 'staging-inventory'", 'read-only staging inventory dispatch');
requireText(workflow, 'candidate_host_port_5176_free=', 'staging isolation port inventory');
requireText(workflow, 'database_target_has_staging_marker=', 'staging database isolation inventory');
requireText(workflow, "inputs.deploy_target == 'staging-provision'", 'explicit staging provisioning dispatch');
requireText(workflow, 'inputs.confirm_staging_provision', 'reviewed staging provisioning confirmation');
requireText(workflow, 'scripts/provision-staging-host.sh', 'tracked staging provisioning script');
requireText(workflow, 'aspb-platform-staging-postgres', 'isolated staging PostgreSQL container');
requireText(workflow, 'COMPOSE_PROJECT_NAME=aspb-platform-staging', 'isolated staging Compose project');
requireText(workflow, 'ASPB_CONTAINER_PREFIX=aspb-platform-staging', 'isolated staging container namespace');
requireText(workflow, 'ASPB_BIND_PORT=5176', 'isolated staging application port');
requireText(workflow, '/tmp/aspb-deploy-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-staging', 'per-run staging artifact path');
requireText(
  workflow,
  '/tmp/aspb-deploy-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-production',
  'per-run production artifact path',
);
requireText(workflow, 'DEPLOY_LOCK_HELD=on', 'checkout covered by inherited deploy lock');
const deployBackupCalls = workflow.match(/bash scripts\/create-deploy-backup\.sh/g)?.length ?? 0;
if (deployBackupCalls !== 2) {
  throw new Error(`CI/deploy contract requires fresh staging and production backups; found ${deployBackupCalls}`);
}
requireText(workflow, 'STAGING_NATIVE_POSTGRES_STORAGE_PATH', 'staging native PostgreSQL capacity path');
requireText(workflow, 'Resolve and validate staging runtime origin', 'staging runtime origin preflight');
requireText(workflow, 'Rejected staging PUBLIC_SITE_URL host:', 'actionable rejected staging host evidence');
requireText(workflow, 'host must contain the staging safety marker', 'staging hostname safety marker');
requireText(
  workflow,
  "STAGING_MIN_DEPLOY_FREE_PERCENT: ${{ vars.STAGING_MIN_DEPLOY_FREE_PERCENT || '5' }}",
  'staging-only free-space percentage override',
);
requireText(workflow, 'MIN_DEPLOY_FREE_PERCENT="$min_free_percent"', 'staging free-space percentage propagation');
requireText(
  workflow,
  'STAGING_PUBLIC_URL: ${{ needs.deploy-staging.outputs.public_url }}',
  'smoke target bound to the deployed staging runtime origin',
);
requireText(
  workflow,
  'ASPB_STAGING_ALLOWED_HOST: ${{ needs.deploy-staging.outputs.allowed_host }}',
  'smoke hostname bound to the deployed staging runtime origin',
);
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
requireText(deploy, 'No pending migrations to apply', 'repeated migration no-op verification');
requireText(deploy, 'npx prisma migrate status', 'post-deploy migration status verification');
requireText(deploy, '"/health/live"', 'explicit live endpoint acceptance');
requireText(deploy, '"/health/ready"', 'explicit ready endpoint acceptance');
requireText(deploy, '"/health/dependencies"', 'public dependency endpoint acceptance');
requireText(deploy, '"/health/dependencies/details"', 'protected dependency endpoint acceptance');
requireText(deploy, '"/metrics"', 'protected metrics endpoint acceptance');
requireText(deploy, 'releaseControlsAcceptance.js', 'release control fail-closed acceptance');
requireText(deploy, 'ALLOW_REMOTE_REBUILD is no longer supported', 'fail-closed remote rebuild gate');
requireText(deploy, 'ALLOW_DEPLOY_WITHOUT_CI_ATTESTATION is no longer supported', 'removed unsigned deploy bypass');
requireText(installImage, '"$attestation_cli" attestation verify "$archive"', 'cryptographic artifact verification');
requireText(installImage, 'DEPLOY_GH_BIN', 'scoped remote attestation verifier');
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
  requireText(compose, 'ASPB_CONTAINER_PREFIX', `${name} environment-specific container names`);
  requireText(compose, 'ASPB_BIND_PORT', `${name} environment-specific host port`);
  const count = compose.split('BUILD_COMMIT_SHA: ${DEPLOY_COMMIT_SHA:-local}').length - 1;
  if (count !== 2) throw new Error(`${name} must pass BUILD_COMMIT_SHA to exactly two application services`);
  const mediaWorkRootCount = compose.split('MEDIA_WORK_ROOT: /var/lib/aspb/media-work').length - 1;
  if (mediaWorkRootCount !== 2)
    throw new Error(`${name} must configure the private media work root for API and worker`);
  const mediaWorkMountCount = compose.split(':/var/lib/aspb/media-work').length - 1;
  if (mediaWorkMountCount !== 2) throw new Error(`${name} must mount the private media work volume in API and worker`);
  requireText(
    compose,
    '${LEGACY_MEDIA_PATH:?LEGACY_MEDIA_PATH is required}:/app/crisis_premium/assets/media:ro',
    `${name} read-only legacy media compatibility mount`,
  );
}
requireText(deploy, 'LEGACY_MEDIA_PATH must be an existing absolute directory', 'legacy media directory validation');
requireText(deploy, 'LEGACY_MEDIA_PATH must be a dedicated directory', 'broad legacy media path refusal');

console.log('CI immutable-image deploy contract is complete.');
