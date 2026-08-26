#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabaseUrl } from './assert-test-database.mjs';

const TEST_VIDEO_BASE64 =
  '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';

try {
  assertSafeTestDatabaseUrl();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const testVideoPath = fileURLToPath(new URL('../crisis_premium/assets/webinar.mp4', import.meta.url));
if (!existsSync(testVideoPath)) {
  if (process.env.NODE_ENV !== 'test') {
    console.error('Refusing to create a media fixture outside NODE_ENV=test');
    process.exit(1);
  }
  mkdirSync(dirname(testVideoPath), { recursive: true });
  writeFileSync(testVideoPath, Buffer.from(TEST_VIDEO_BASE64, 'base64'), { flag: 'wx', mode: 0o600 });
  console.log('Created deterministic test-only webinar media fixture.');
}

const prismaCliPath = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
if (!existsSync(prismaCliPath)) {
  console.error('Local Prisma CLI is missing. Run npm ci before preparing the test database.');
  process.exit(1);
}

// Execute the pinned workspace CLI directly. Going through npx adds a network-
// aware resolution step and made the release gate depend on a slow cold cache.
const command = process.execPath;
const resetSetting = process.env.ASPB_ALLOW_TEST_SCHEMA_RESET;
if (resetSetting && resetSetting !== 'on' && resetSetting !== 'off') {
  console.error('ASPB_ALLOW_TEST_SCHEMA_RESET must be either on or off when provided');
  process.exit(1);
}

const prismaArgs =
  resetSetting === 'on'
    ? [prismaCliPath, 'migrate', 'reset', '--force', '--skip-seed']
    : [prismaCliPath, 'migrate', 'deploy'];

if (resetSetting === 'on') {
  console.warn('Explicit test-only schema reset authorized by ASPB_ALLOW_TEST_SCHEMA_RESET=on.');
} else {
  console.log('Applying additive migrations without resetting the test schema.');
}

const result = spawnSync(command, prismaArgs, {
  env: process.env,
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (result.status !== 0) process.exit(result.status ?? 1);

// Playwright waits on /health/ready before it can run spec-level resetDb(). A
// previous interrupted test may have truncated these control-plane rows, so
// restore the test-only invariant here, before the server starts.
const prisma = new PrismaClient();
try {
  await prisma.$transaction(async tx => {
    await tx.organization.upsert({
      where: { id: 'org_aspb' },
      update: { status: 'ACTIVE' },
      create: {
        id: 'org_aspb',
        name: 'АСПБ',
        slug: 'aspb',
        status: 'ACTIVE',
        settingsJson: { compatibilityMode: 'legacy', scopeVersion: 1 },
      },
    });
    await tx.user.upsert({
      where: { id: 'user_aspb_system_owner' },
      update: { status: 'ACTIVE' },
      create: {
        id: 'user_aspb_system_owner',
        emailNormalized: 'legacy-owner@system.invalid',
        displayName: 'Системный владелец АСПБ',
        kind: 'SYSTEM',
        status: 'ACTIVE',
      },
    });
    await tx.organizationMembership.upsert({
      where: { id: 'membership_aspb_system_owner' },
      update: { role: 'OWNER', status: 'ACTIVE' },
      create: {
        id: 'membership_aspb_system_owner',
        organizationId: 'org_aspb',
        userId: 'user_aspb_system_owner',
        role: 'OWNER',
        status: 'ACTIVE',
        permissionsJson: { systemBootstrap: true },
      },
    });
    await tx.webinar.upsert({
      where: { id: 'webinar_aspb_legacy' },
      update: { organizationId: 'org_aspb', legacyCompatibility: true },
      create: {
        id: 'webinar_aspb_legacy',
        organizationId: 'org_aspb',
        slug: 'legacy-webinar',
        title: 'Ежедневный вебинар АСПБ',
        contentStatus: 'PUBLISHED',
        visibility: 'UNLISTED',
        legacyCompatibility: true,
        mediaStatus: 'READY',
        scenarioStatus: 'PUBLISHED',
      },
    });
    await tx.tenantRolloutPolicy.createMany({
      data: [
        'PLATFORM_ACCOUNTS_ONBOARDING',
        'CREATOR_DASHBOARD',
        'PUBLIC_CATALOG',
        'TENANT_CRM',
        'TENANT_TELEGRAM',
        'PROVIDER_JOBS',
        'ANALYTICS_MODERATION',
      ].map(feature => ({ feature, mode: 'ENABLED' })),
      skipDuplicates: true,
    });
    await tx.tenantRolloutPolicy.updateMany({
      data: { mode: 'ENABLED', updatedByAdminUserId: null },
    });
    await tx.platformFeatureFlag.createMany({
      data: [
        { key: 'analytics_dashboard', enabled: true, description: 'Tenant analytics test flag.' },
        { key: 'public_reporting', enabled: false, description: 'Public reporting test flag.' },
        { key: 'moderation_actions', enabled: true, description: 'Moderation actions test flag.' },
        { key: 'provider_jobs', enabled: true, description: 'Provider jobs test flag.' },
      ],
      skipDuplicates: true,
    });
    await tx.platformFeatureFlag.updateMany({
      where: { key: { in: ['analytics_dashboard', 'moderation_actions', 'provider_jobs'] } },
      data: { enabled: true, updatedByAdminUserId: null },
    });
  });
  console.log('Restored deterministic test control-plane invariants.');
} finally {
  await prisma.$disconnect();
}
