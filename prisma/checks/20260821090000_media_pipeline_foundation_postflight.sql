SELECT COUNT(*) AS invalid_ready_assets
FROM "media_assets"
WHERE "status" = 'ready'
  AND ("checksum_sha256" IS NULL OR "duration_seconds" IS NULL OR "manifest_storage_key" IS NULL OR "poster_storage_key" IS NULL);

SELECT COUNT(*) AS cross_tenant_media_links
FROM "media_assets" asset
JOIN "webinars" webinar ON webinar."id" = asset."webinar_id"
WHERE webinar."organization_id" <> asset."organization_id";
