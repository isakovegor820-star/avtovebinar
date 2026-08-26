import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ScriptedChatScenario } from '../scriptedChat.js';
import { DEFAULT_ORGANIZATION_ID, DEFAULT_SYSTEM_OWNER_USER_ID, DEFAULT_WEBINAR_ID } from './constants.js';

const LEGACY_SOURCE_KIND = 'LEGACY_FILE';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function legacyChatScenarioFingerprint(scenario: ScriptedChatScenario) {
  return crypto.createHash('sha256').update(canonicalJson(scenario)).digest('hex');
}

export function legacyChatScenarioProjection(scenario: ScriptedChatScenario) {
  return scenario.messages.map((message, orderIndex) => ({
    orderIndex,
    offsetSeconds: message.sendAtSeconds,
    kind: 'PREPARED_QUESTION' as const,
    status: 'APPROVED' as const,
    text: message.message,
    authorLabel: 'Подготовленный вопрос',
    isSynthetic: true,
    metadataJson: {
      legacyMessageId: message.id,
      legacyKind: message.kind,
      topic: message.topic ?? null,
      visible: message.visible,
      allowAfterVideo: message.allowAfterVideo,
    },
  }));
}

async function assertExactCompatibilityTarget(db: PrismaClient) {
  const [organization, webinar, systemMembership] = await Promise.all([
    db.organization.findFirst({
      where: { id: DEFAULT_ORGANIZATION_ID, status: 'ACTIVE' },
      select: { id: true },
    }),
    db.webinar.findFirst({
      where: {
        id: DEFAULT_WEBINAR_ID,
        organizationId: DEFAULT_ORGANIZATION_ID,
        legacyCompatibility: true,
      },
      select: { id: true },
    }),
    db.organizationMembership.findFirst({
      where: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        userId: DEFAULT_SYSTEM_OWNER_USER_ID,
        status: 'ACTIVE',
        user: { kind: 'SYSTEM', status: 'ACTIVE' },
      },
      select: { id: true },
    }),
  ]);
  if (!organization || !webinar || !systemMembership) {
    throw new Error('Exact legacy compatibility tenant, webinar, and system identity are required');
  }
}

export async function backfillLegacyChatScenario(
  db: PrismaClient,
  scenario: ScriptedChatScenario,
  options: { apply?: boolean } = {},
) {
  await assertExactCompatibilityTarget(db);
  const fingerprint = legacyChatScenarioFingerprint(scenario);
  const messages = legacyChatScenarioProjection(scenario);
  const existingImports = await db.chatScenario.findMany({
    where: { webinarId: DEFAULT_WEBINAR_ID, sourceKind: LEGACY_SOURCE_KIND },
    select: { id: true, sourceFingerprint: true },
  });
  const exact = existingImports.find(item => item.sourceFingerprint === fingerprint);
  if (exact) {
    return { mode: options.apply ? 'apply' : 'dry-run', action: 'no-op', fingerprint, messageCount: messages.length };
  }
  if (existingImports.length > 0) {
    throw new Error('Legacy scenario fingerprint changed after a prior import; refusing partial or parallel import');
  }
  if (!options.apply) {
    return { mode: 'dry-run', action: 'would-create', fingerprint, messageCount: messages.length };
  }

  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${DEFAULT_ORGANIZATION_ID}:${DEFAULT_WEBINAR_ID}:legacy-chat-import`}, 7106009024))`;
    const concurrent = await tx.chatScenario.findFirst({
      where: { webinarId: DEFAULT_WEBINAR_ID, sourceKind: LEGACY_SOURCE_KIND },
      select: { sourceFingerprint: true },
    });
    if (concurrent) {
      if (concurrent.sourceFingerprint === fingerprint) return;
      throw new Error('Concurrent legacy import has a different fingerprint');
    }
    const latest = await tx.chatScenario.aggregate({
      where: { webinarId: DEFAULT_WEBINAR_ID },
      _max: { version: true },
    });
    const created = await tx.chatScenario.create({
      data: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        webinarId: DEFAULT_WEBINAR_ID,
        version: (latest._max.version ?? 0) + 1,
        status: 'DRAFT',
        createdById: DEFAULT_SYSTEM_OWNER_USER_ID,
        sourceKind: LEGACY_SOURCE_KIND,
        sourceVersion: scenario.version,
        sourceFingerprint: fingerprint,
        importedAt: new Date(),
        runtimeEnabled: false,
      },
    });
    await tx.chatScenarioMessage.createMany({
      data: messages.map(message => ({
        ...message,
        scenarioId: created.id,
        organizationId: DEFAULT_ORGANIZATION_ID,
      })),
    });
    await tx.auditLog.create({
      data: {
        userId: DEFAULT_SYSTEM_OWNER_USER_ID,
        organizationId: DEFAULT_ORGANIZATION_ID,
        action: 'chat_scenario.legacy_shadow_imported',
        entityType: 'chat_scenario',
        entityId: created.id,
        afterJson: {
          webinarId: DEFAULT_WEBINAR_ID,
          fingerprint,
          messageCount: messages.length,
          status: 'DRAFT',
          runtimeEnabled: false,
        },
      },
    });
  });
  return { mode: 'apply', action: 'created', fingerprint, messageCount: messages.length };
}

export async function compareLegacyChatScenarioShadow(db: PrismaClient, scenario: ScriptedChatScenario) {
  const fingerprint = legacyChatScenarioFingerprint(scenario);
  const expected = legacyChatScenarioProjection(scenario);
  const imported = await db.chatScenario.findFirst({
    where: {
      organizationId: DEFAULT_ORGANIZATION_ID,
      webinarId: DEFAULT_WEBINAR_ID,
      sourceKind: LEGACY_SOURCE_KIND,
      sourceFingerprint: fingerprint,
    },
    include: { messages: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!imported) return { fingerprint, matches: false, reason: 'missing_shadow', mismatchIndexes: [] as number[] };
  const mismatchIndexes = expected
    .map((message, index) => {
      const actual = imported.messages[index];
      return !actual ||
        actual.orderIndex !== message.orderIndex ||
        actual.offsetSeconds !== message.offsetSeconds ||
        actual.text !== message.text ||
        actual.kind !== message.kind ||
        actual.isSynthetic !== true
        ? index
        : -1;
    })
    .filter(index => index >= 0);
  if (imported.messages.length !== expected.length && mismatchIndexes.length === 0)
    mismatchIndexes.push(expected.length);
  return {
    fingerprint,
    matches: mismatchIndexes.length === 0 && imported.runtimeEnabled === false && imported.status === 'DRAFT',
    reason: mismatchIndexes.length > 0 ? 'projection_mismatch' : null,
    mismatchIndexes,
    expectedCount: expected.length,
    actualCount: imported.messages.length,
  };
}
