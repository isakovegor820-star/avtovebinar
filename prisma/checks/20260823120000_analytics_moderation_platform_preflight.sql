-- Read-only inventory before ANA/MOD platform expand. Retain this output.
SELECT COUNT(*) AS existing_v1_analytics_events FROM "events" WHERE "schema_version" = 1;
SELECT COUNT(*) AS existing_platform_organizations FROM "organizations";
SELECT COUNT(*) AS published_webinars_available_for_reports
FROM "webinars"
WHERE "content_status" = 'published' AND "archived_at" IS NULL;
SELECT COUNT(*) AS verified_authors_available_for_reports
FROM "author_profiles"
WHERE "verification_status" = 'verified';
SELECT COUNT(*) AS invalid_existing_webinar_content_versions
FROM "webinars" WHERE "content_version" <= 0;
SELECT COUNT(*) AS existing_case_table
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name IN ('content_reports', 'moderation_correction_requests', 'platform_feature_flags');
