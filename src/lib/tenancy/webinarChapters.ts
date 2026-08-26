import type { OrganizationMembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../http.js';
import { requireTenantRole, type TenantContext } from './context.js';

const CREATOR_ROLES = ['OWNER', 'AUTHOR'] as const satisfies readonly OrganizationMembershipRole[];
const idSchema = z.string().trim().min(1).max(191);
const titleSchema = z.string().trim().min(2).max(240);
const descriptionSchema = z.string().trim().min(1).max(2_000).nullable();
const startMsSchema = z.number().int().nonnegative().max(86_400_000);
const orderIndexSchema = z.number().int().nonnegative().max(10_000);

export const chapterListQuerySchema = z.object({ transcriptId: idSchema.optional() }).strict();
export const chapterCreateSchema = z
  .object({
    transcriptId: idSchema,
    expectedTranscriptRevision: z.number().int().positive(),
    startMs: startMsSchema,
    title: titleSchema,
    description: descriptionSchema.optional(),
    orderIndex: orderIndexSchema.optional(),
  })
  .strict();
export const chapterUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    startMs: startMsSchema.optional(),
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    orderIndex: orderIndexSchema.optional(),
  })
  .strict()
  .refine(
    value => Object.keys(value).some(key => key !== 'expectedRevision'),
    'At least one chapter field is required',
  );
export const chapterDeleteSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const chapterReorderSchema = z
  .object({
    transcriptId: idSchema,
    items: z
      .array(
        z
          .object({ id: idSchema, expectedRevision: z.number().int().positive(), orderIndex: orderIndexSchema })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.items.map(item => item.id)).size !== value.items.length) {
      context.addIssue({ code: 'custom', message: 'Chapter ids must be unique' });
    }
    if (new Set(value.items.map(item => item.orderIndex)).size !== value.items.length) {
      context.addIssue({ code: 'custom', message: 'Chapter order indexes must be unique' });
    }
  });

type ChapterTransaction = Prisma.TransactionClient;

function unavailable(entity = 'chapter'): never {
  throw new AppError(404, 'Глава не найдена', undefined, `${entity}_not_found`);
}

function revisionConflict(): never {
  throw new AppError(409, 'Главы уже изменились. Обновите данные и повторите.', undefined, 'chapter_revision_conflict');
}

function immutable(): never {
  throw new AppError(
    409,
    'Опубликованная расшифровка неизменяема. Создайте новую версию расшифровки.',
    undefined,
    'chapter_published_immutable',
  );
}

async function requireCreator(db: PrismaClient, context: TenantContext) {
  requireTenantRole(context, CREATOR_ROLES);
  const membership = await db.organizationMembership.findFirst({
    where: {
      id: context.membershipId,
      organizationId: context.organizationId,
      userId: context.userId,
      role: { in: [...CREATOR_ROLES] },
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
      user: { kind: 'HUMAN', status: 'ACTIVE' },
    },
    select: { role: true },
  });
  if (!membership)
    throw new AppError(403, 'Требуются права автора или владельца', undefined, 'creator_permission_denied');
  return membership.role;
}

function webinarWhere(context: TenantContext, role: OrganizationMembershipRole, webinarId: string) {
  return {
    id: webinarId,
    organizationId: context.organizationId,
    ...(role === 'AUTHOR' ? { authorProfile: { userId: context.userId } } : {}),
  } satisfies Prisma.WebinarWhereInput;
}

async function assertWebinar(db: PrismaClient, context: TenantContext, webinarId: string) {
  const role = await requireCreator(db, context);
  const webinar = await db.webinar.findFirst({ where: webinarWhere(context, role, webinarId), select: { id: true } });
  if (!webinar) unavailable('webinar');
  return webinar;
}

async function transcriptForMutation(
  tx: ChapterTransaction,
  context: TenantContext,
  webinarId: string,
  transcriptId: string,
  expectedRevision?: number,
) {
  const transcript = await tx.transcript.findFirst({
    where: { id: transcriptId, webinarId, organizationId: context.organizationId },
    select: {
      id: true,
      status: true,
      revision: true,
      mediaAsset: { select: { durationSeconds: true } },
      webinar: { select: { contentStatus: true } },
    },
  });
  if (!transcript) unavailable('transcript');
  if (expectedRevision !== undefined && transcript.revision !== expectedRevision) revisionConflict();
  if (transcript.status === 'PUBLISHED') immutable();
  if (!['DRAFT', 'NEEDS_REVIEW'].includes(transcript.webinar.contentStatus)) {
    throw new AppError(409, 'Верните вебинар в редактируемый статус', undefined, 'chapter_webinar_not_editable');
  }
  if (!transcript.mediaAsset.durationSeconds) {
    throw new AppError(409, 'Длительность видео не определена', undefined, 'chapter_media_duration_missing');
  }
  return transcript;
}

function assertWithinDuration(startMs: number, durationSeconds: number) {
  if (startMs >= durationSeconds * 1_000) {
    throw new AppError(
      422,
      'Таймкод должен находиться внутри видео',
      { maximumStartMs: durationSeconds * 1_000 - 1 },
      'chapter_start_out_of_bounds',
    );
  }
}

function projection(chapter: {
  id: string;
  transcriptId: string;
  startMs: number;
  title: string;
  description: string | null;
  orderIndex: number;
  revision: number;
  origin: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...chapter };
}

export async function listCreatorWebinarChapters(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  queryInput: unknown,
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const query = chapterListQuerySchema.parse(queryInput);
  await assertWebinar(db, context, webinarId);
  const transcript = await db.transcript.findFirst({
    where: {
      webinarId,
      organizationId: context.organizationId,
      ...(query.transcriptId ? { id: query.transcriptId } : {}),
    },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, revision: true, status: true },
  });
  if (query.transcriptId && !transcript) unavailable('transcript');
  if (!transcript) return { transcript: null, chapters: [] };
  const chapters = await db.webinarChapter.findMany({
    where: { webinarId, organizationId: context.organizationId, transcriptId: transcript.id },
    orderBy: [{ orderIndex: 'asc' }, { startMs: 'asc' }, { id: 'asc' }],
  });
  return { transcript, chapters: chapters.map(projection) };
}

export async function createCreatorWebinarChapter(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const data = chapterCreateSchema.parse(input);
  await assertWebinar(db, context, webinarId);
  try {
    return await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${data.transcriptId}, 91827410))`;
      const transcript = await transcriptForMutation(
        tx,
        context,
        webinarId,
        data.transcriptId,
        data.expectedTranscriptRevision,
      );
      assertWithinDuration(data.startMs, transcript.mediaAsset.durationSeconds!);
      const max = await tx.webinarChapter.aggregate({
        where: { webinarId, transcriptId: data.transcriptId },
        _max: { orderIndex: true },
      });
      const chapter = await tx.webinarChapter.create({
        data: {
          organizationId: context.organizationId,
          webinarId,
          transcriptId: data.transcriptId,
          startMs: data.startMs,
          title: data.title,
          description: data.description ?? null,
          orderIndex: data.orderIndex ?? (max._max.orderIndex ?? -1) + 1,
          origin: 'MANUAL',
          createdByUserId: context.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'webinar_chapter.created',
          entityType: 'WebinarChapter',
          entityId: chapter.id,
          afterJson: { transcriptId: chapter.transcriptId, startMs: chapter.startMs, orderIndex: chapter.orderIndex },
        },
      });
      return projection(chapter);
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') revisionConflict();
    throw error;
  }
}

export async function updateCreatorWebinarChapter(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  chapterIdInput: unknown,
  input: unknown,
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const chapterId = idSchema.parse(chapterIdInput);
  const data = chapterUpdateSchema.parse(input);
  await assertWebinar(db, context, webinarId);
  try {
    return await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chapterId}, 91827411))`;
      const current = await tx.webinarChapter.findFirst({
        where: { id: chapterId, webinarId, organizationId: context.organizationId },
      });
      if (!current) unavailable();
      const transcript = await transcriptForMutation(tx, context, webinarId, current.transcriptId);
      if (current.revision !== data.expectedRevision) revisionConflict();
      assertWithinDuration(data.startMs ?? current.startMs, transcript.mediaAsset.durationSeconds!);
      const updated = await tx.webinarChapter.updateMany({
        where: { id: chapterId, organizationId: context.organizationId, revision: data.expectedRevision },
        data: {
          ...(data.startMs !== undefined ? { startMs: data.startMs } : {}),
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.orderIndex !== undefined ? { orderIndex: data.orderIndex } : {}),
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) revisionConflict();
      const chapter = await tx.webinarChapter.findUniqueOrThrow({ where: { id: chapterId } });
      await tx.auditLog.create({
        data: {
          userId: context.userId,
          organizationId: context.organizationId,
          correlationId: context.correlationId,
          action: 'webinar_chapter.updated',
          entityType: 'WebinarChapter',
          entityId: chapter.id,
          beforeJson: {
            startMs: current.startMs,
            title: current.title,
            orderIndex: current.orderIndex,
            revision: current.revision,
          },
          afterJson: {
            startMs: chapter.startMs,
            title: chapter.title,
            orderIndex: chapter.orderIndex,
            revision: chapter.revision,
          },
        },
      });
      return projection(chapter);
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') revisionConflict();
    throw error;
  }
}

export async function deleteCreatorWebinarChapter(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  chapterIdInput: unknown,
  input: unknown,
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const chapterId = idSchema.parse(chapterIdInput);
  const data = chapterDeleteSchema.parse(input);
  await assertWebinar(db, context, webinarId);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chapterId}, 91827412))`;
    const chapter = await tx.webinarChapter.findFirst({
      where: { id: chapterId, webinarId, organizationId: context.organizationId },
    });
    if (!chapter) unavailable();
    await transcriptForMutation(tx, context, webinarId, chapter.transcriptId);
    if (chapter.revision !== data.expectedRevision) revisionConflict();
    const removed = await tx.webinarChapter.deleteMany({
      where: { id: chapter.id, organizationId: context.organizationId, revision: data.expectedRevision },
    });
    if (removed.count !== 1) revisionConflict();
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'webinar_chapter.deleted',
        entityType: 'WebinarChapter',
        entityId: chapter.id,
        beforeJson: { transcriptId: chapter.transcriptId, startMs: chapter.startMs, orderIndex: chapter.orderIndex },
      },
    });
    return { id: chapter.id };
  });
}

export async function reorderCreatorWebinarChapters(
  db: PrismaClient,
  context: TenantContext,
  webinarIdInput: unknown,
  input: unknown,
) {
  const webinarId = idSchema.parse(webinarIdInput);
  const data = chapterReorderSchema.parse(input);
  await assertWebinar(db, context, webinarId);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${data.transcriptId}, 91827413))`;
    await transcriptForMutation(tx, context, webinarId, data.transcriptId);
    const chapters = await tx.webinarChapter.findMany({
      where: { webinarId, organizationId: context.organizationId, transcriptId: data.transcriptId },
      orderBy: { id: 'asc' },
    });
    if (chapters.length !== data.items.length) revisionConflict();
    const currentById = new Map(chapters.map(chapter => [chapter.id, chapter]));
    if (data.items.some(item => currentById.get(item.id)?.revision !== item.expectedRevision)) revisionConflict();
    const temporaryBase = Math.max(...chapters.map(chapter => chapter.orderIndex), 0) + 20_000;
    for (const [index, item] of data.items.entries()) {
      await tx.webinarChapter.update({ where: { id: item.id }, data: { orderIndex: temporaryBase + index } });
    }
    for (const item of data.items) {
      await tx.webinarChapter.update({
        where: { id: item.id },
        data: { orderIndex: item.orderIndex, revision: { increment: 1 } },
      });
    }
    await tx.auditLog.create({
      data: {
        userId: context.userId,
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        action: 'webinar_chapter.reordered',
        entityType: 'Transcript',
        entityId: data.transcriptId,
        beforeJson: { order: chapters.map(chapter => ({ id: chapter.id, orderIndex: chapter.orderIndex })) },
        afterJson: { order: data.items.map(item => ({ id: item.id, orderIndex: item.orderIndex })) },
      },
    });
    const reordered = await tx.webinarChapter.findMany({
      where: { webinarId, organizationId: context.organizationId, transcriptId: data.transcriptId },
      orderBy: [{ orderIndex: 'asc' }, { startMs: 'asc' }, { id: 'asc' }],
    });
    return reordered.map(projection);
  });
}
