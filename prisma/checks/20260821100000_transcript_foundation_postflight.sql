SELECT COUNT(*) AS invalid_transcript_states
FROM "transcripts"
WHERE "version" <= 0
   OR "revision" <= 0
   OR ("status" = 'draft' AND ("reviewed_by_user_id" IS NOT NULL OR "reviewed_at" IS NOT NULL OR "published_at" IS NOT NULL))
   OR ("status" = 'reviewed' AND ("reviewed_by_user_id" IS NULL OR "reviewed_at" IS NULL))
   OR ("status" = 'published' AND ("reviewed_by_user_id" IS NULL OR "reviewed_at" IS NULL OR "published_at" IS NULL));

SELECT COUNT(*) AS invalid_transcript_segments
FROM "transcript_segments"
WHERE "order_index" < 0
   OR "start_ms" < 0
   OR "end_ms" <= "start_ms"
   OR length(btrim("text")) = 0;

SELECT COUNT(*) AS cross_tenant_transcript_links
FROM "transcripts" transcript
JOIN "webinars" webinar ON webinar."id" = transcript."webinar_id"
JOIN "media_assets" asset ON asset."id" = transcript."media_asset_id"
WHERE transcript."organization_id" <> webinar."organization_id"
   OR transcript."organization_id" <> asset."organization_id";

SELECT COUNT(*) AS webinars_with_multiple_published_transcripts
FROM (
  SELECT "webinar_id"
  FROM "transcripts"
  WHERE "status" = 'published'
  GROUP BY "webinar_id"
  HAVING COUNT(*) > 1
) duplicates;
