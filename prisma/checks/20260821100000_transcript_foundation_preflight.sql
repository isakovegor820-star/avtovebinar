SELECT COUNT(*) AS ready_webinars_without_current_asset
FROM "webinars"
WHERE "media_status" = 'ready'
  AND "current_media_asset_id" IS NULL;

SELECT COUNT(*) AS cross_tenant_current_media_links
FROM "webinars" webinar
JOIN "media_assets" asset ON asset."id" = webinar."current_media_asset_id"
WHERE webinar."organization_id" <> asset."organization_id";
