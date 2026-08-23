-- Applied after 20260823120000 and before the durability expand. These rows
-- exercise every altered table without inventing provider state.
INSERT INTO "organizations" ("id", "name", "slug", "updated_at")
VALUES ('media_stt_fixture_org', 'Media STT fixture tenant', 'media-stt-fixture-tenant', CURRENT_TIMESTAMP);

INSERT INTO "users" ("id", "email_normalized", "display_name", "status", "email_verified_at", "updated_at")
VALUES (
  'media_stt_fixture_user',
  'media-stt-fixture@example.test',
  'Media STT fixture user',
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "webinars" ("id", "organization_id", "slug", "title")
VALUES ('media_stt_fixture_webinar', 'media_stt_fixture_org', 'media-stt-fixture-webinar', 'Media STT fixture Webinar');

INSERT INTO "media_assets" (
  "id", "organization_id", "webinar_id", "created_by_user_id", "version", "status",
  "original_file_name", "mime_type", "size_bytes", "storage_key", "updated_at"
)
VALUES (
  'media_stt_fixture_asset', 'media_stt_fixture_org', 'media_stt_fixture_webinar',
  'media_stt_fixture_user', 1, 'uploading', 'legacy.mp4', 'video/mp4', 5242880,
  'fixture/media-stt/source', CURRENT_TIMESTAMP
);

INSERT INTO "media_uploads" (
  "id", "organization_id", "asset_id", "provider", "provider_upload_key", "status",
  "part_size_bytes", "uploaded_parts_json", "expires_at", "updated_at"
)
VALUES (
  'media_stt_fixture_upload', 'media_stt_fixture_org', 'media_stt_fixture_asset',
  'local_fs', 'media-stt-fixture-provider-upload', 'uploading', 5242880,
  '[{"partNumber":1,"etag":"legacy-etag"}]'::jsonb,
  CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP
);

INSERT INTO "content_jobs" (
  "id", "organization_id", "webinar_id", "media_asset_id", "requested_by_user_id",
  "type", "status", "dedup_key", "updated_at"
)
VALUES (
  'media_stt_fixture_job', 'media_stt_fixture_org', 'media_stt_fixture_webinar',
  'media_stt_fixture_asset', 'media_stt_fixture_user', 'TRANSCRIBE', 'pending',
  'media-stt-fixture-transcribe-v1', CURRENT_TIMESTAMP
);

INSERT INTO "ai_operation_provenance" (
  "id", "organization_id", "webinar_id", "media_asset_id", "operation_type",
  "provider_id", "model_id", "template_version", "input_refs_json", "status"
)
VALUES (
  'media_stt_fixture_provenance', 'media_stt_fixture_org', 'media_stt_fixture_webinar',
  'media_stt_fixture_asset', 'speech_to_text', 'legacy-provider', 'legacy-model',
  'legacy-template', '{}'::jsonb, 'succeeded'
);

CREATE TEMP TABLE "media_stt_fixture_counts" AS
SELECT
  (SELECT COUNT(*) FROM "media_assets") AS media_assets,
  (SELECT COUNT(*) FROM "media_uploads") AS media_uploads,
  (SELECT COUNT(*) FROM "content_jobs") AS content_jobs,
  (SELECT COUNT(*) FROM "ai_operation_provenance") AS provenance;
