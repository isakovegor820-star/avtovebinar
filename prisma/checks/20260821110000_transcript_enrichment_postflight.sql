SELECT COUNT(*) AS cross_tenant_enrichment_links
FROM "ai_suggestions" suggestion
JOIN "webinars" webinar ON webinar."id" = suggestion."webinar_id"
JOIN "transcripts" transcript ON transcript."id" = suggestion."transcript_id"
JOIN "ai_operation_provenance" provenance ON provenance."id" = suggestion."provenance_id"
WHERE suggestion."organization_id" <> webinar."organization_id"
   OR suggestion."organization_id" <> transcript."organization_id"
   OR suggestion."organization_id" <> provenance."organization_id";

SELECT COUNT(*) AS invalid_suggestion_review_states
FROM "ai_suggestions"
WHERE "revision" <= 0 OR "order_index" < 0
   OR ("status" = 'pending' AND ("reviewed_by_user_id" IS NOT NULL OR "reviewed_at" IS NOT NULL))
   OR ("status" IN ('accepted', 'rejected') AND ("reviewed_by_user_id" IS NULL OR "reviewed_at" IS NULL));

SELECT COUNT(*) AS published_segments_without_search_vector
FROM "transcript_segments" segment
JOIN "transcripts" transcript ON transcript."id" = segment."transcript_id"
WHERE transcript."status" = 'published'
  AND segment."search_vector" IS NULL;
