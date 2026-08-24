-- All violation counts must be zero.
SELECT COUNT(*) AS terminal_media_uploads_with_completion_claim
FROM "media_uploads"
WHERE "status" IN ('completed', 'cancelled')
  AND ("complete_claim_token" IS NOT NULL OR "complete_claim_expires_at" IS NOT NULL);

SELECT COUNT(*) AS partial_media_upload_completion_claims
FROM "media_uploads"
WHERE ("complete_claim_token" IS NULL) <> ("complete_claim_expires_at" IS NULL);
