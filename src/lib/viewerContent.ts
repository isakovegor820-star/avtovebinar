import type { PrismaClient } from '@prisma/client';

const PROCESSING_STATUSES = new Set(['CREATED', 'UPLOADING', 'VALIDATING', 'TRANSCODING', 'TRANSCRIBING', 'ENRICHING']);

export type ViewerContentScope = {
  organizationId: string;
  webinarId: string;
  webinarSessionId: string;
};

export async function getPublishedViewerContent(
  db: PrismaClient,
  scope: ViewerContentScope,
  paths: {
    captionsPath?: (transcriptId: string) => string | null;
    materialPath: (materialId: string) => string;
  },
) {
  const snapshot = await db.$transaction(
    async tx => {
      const webinar = await tx.webinar.findFirst({
        where: { id: scope.webinarId, organizationId: scope.organizationId },
        select: {
          currentMediaAssetId: true,
          currentMediaAsset: { select: { status: true } },
          mediaAssets: { orderBy: { version: 'desc' }, take: 1, select: { status: true } },
          sources: {
            orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
            select: { id: true, type: true, title: true, url: true, accessedAt: true, note: true },
          },
          materials: {
            where: { status: 'READY', deletedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, displayName: true, mimeType: true, sizeBytes: true },
          },
        },
      });
      if (!webinar) return null;
      const transcript = webinar.currentMediaAssetId
        ? await tx.transcript.findFirst({
            where: {
              organizationId: scope.organizationId,
              webinarId: scope.webinarId,
              mediaAssetId: webinar.currentMediaAssetId,
              status: 'PUBLISHED',
            },
            orderBy: { version: 'desc' },
            include: {
              segments: { orderBy: { orderIndex: 'asc' } },
              chapters: { orderBy: [{ orderIndex: 'asc' }, { startMs: 'asc' }] },
            },
          })
        : null;
      return { webinar, transcript };
    },
    { isolationLevel: 'RepeatableRead' },
  );
  if (!snapshot) return null;

  const { webinar, transcript } = snapshot;
  const latestStatus = webinar.mediaAssets[0]?.status ?? null;
  const mediaState =
    webinar.currentMediaAsset?.status === 'READY'
      ? 'ready'
      : latestStatus && PROCESSING_STATUSES.has(latestStatus)
        ? 'processing'
        : latestStatus === 'FAILED'
          ? 'error'
          : 'unavailable';

  return {
    webinarSessionId: scope.webinarSessionId,
    mediaState,
    consistencyKey: transcript ? `${transcript.id}:v${transcript.version}` : null,
    transcript: transcript
      ? {
          id: transcript.id,
          version: transcript.version,
          language: transcript.language,
          publishedAt: transcript.publishedAt?.toISOString() ?? null,
          captionsUrl: paths.captionsPath?.(transcript.id) ?? null,
          segments: transcript.segments.map(segment => ({
            startMs: segment.startMs,
            endMs: segment.endMs,
            speaker: segment.speaker,
            text: segment.text,
          })),
        }
      : null,
    chapters: transcript
      ? transcript.chapters.map(chapter => ({
          id: chapter.id,
          startMs: chapter.startMs,
          title: chapter.title,
          description: chapter.description,
        }))
      : [],
    materials: [
      ...webinar.sources.map(source => ({
        kind: 'LINK' as const,
        id: source.id,
        type: source.type,
        title: source.title,
        url: source.url,
        accessedAt: source.accessedAt?.toISOString().slice(0, 10) ?? null,
        note: source.note,
      })),
      ...webinar.materials.map(material => ({
        kind: 'FILE' as const,
        id: material.id,
        title: material.displayName,
        mimeType: material.mimeType,
        sizeBytes: material.sizeBytes.toString(),
        downloadPath: paths.materialPath(material.id),
      })),
    ],
  };
}
