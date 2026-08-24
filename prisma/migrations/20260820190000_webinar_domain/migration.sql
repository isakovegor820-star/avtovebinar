-- WEB-001/WEB-002/WEB-003 expand/backfill migration.
-- Existing WebinarSession rows are attached to one deterministic compatibility Webinar
-- per organization. No legacy session, registration, recording, CRM or delivery row is removed.
-- PostgreSQL lock profile:
--   * new enum/table/index creation does not lock legacy application tables;
--   * ADD COLUMN and SET NOT NULL require brief ACCESS EXCLUSIVE locks on webinar_sessions;
--   * the backfill UPDATE takes row locks and writes one new column per legacy session;
--   * FK validation uses SHARE UPDATE EXCLUSIVE and permits normal reads/writes;
--   * replacing the scheduled_at unique index scans webinar_sessions and must run while the
--     deployment script has quiesced API/workers. lock_timeout fails closed on contention.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE TYPE "taxonomy_status" AS ENUM ('active', 'archived');
CREATE TYPE "webinar_content_status" AS ENUM (
  'draft',
  'needs_review',
  'ready',
  'in_moderation',
  'published',
  'archived'
);
CREATE TYPE "webinar_visibility" AS ENUM ('public', 'unlisted', 'private');
CREATE TYPE "webinar_freshness_status" AS ENUM ('current', 'review_due', 'outdated', 'superseded', 'unknown');
CREATE TYPE "webinar_audience_level" AS ENUM ('introductory', 'practitioner', 'advanced', 'all_levels');
CREATE TYPE "webinar_format" AS ENUM ('recorded', 'premiere', 'on_demand');
CREATE TYPE "webinar_media_status" AS ENUM ('not_uploaded', 'processing', 'ready', 'failed');
CREATE TYPE "webinar_transcript_status" AS ENUM ('not_available', 'draft', 'reviewed', 'published');
CREATE TYPE "webinar_scenario_status" AS ENUM ('not_available', 'draft', 'published');
CREATE TYPE "webinar_source_type" AS ENUM (
  'regulation',
  'statute_provision',
  'court_decision',
  'official_guidance',
  'official_source',
  'template_or_checklist',
  'other'
);
CREATE TYPE "webinar_session_lifecycle_status" AS ENUM (
  'scheduled',
  'room_open',
  'live',
  'replay',
  'closed',
  'cancelled'
);

CREATE TABLE "legal_practice_areas" (
  "id" TEXT NOT NULL,
  "parent_id" TEXT,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "taxonomy_status" NOT NULL DEFAULT 'active',
  "order_index" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legal_practice_areas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_practice_areas_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "legal_practice_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "legal_practice_areas_slug_length_check" CHECK (char_length("slug") BETWEEN 2 AND 100),
  CONSTRAINT "legal_practice_areas_name_length_check" CHECK (char_length("name") BETWEEN 2 AND 160),
  CONSTRAINT "legal_practice_areas_not_own_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);
CREATE UNIQUE INDEX "legal_practice_areas_slug_key" ON "legal_practice_areas"("slug");
CREATE INDEX "legal_practice_areas_parent_id_status_order_index_idx" ON "legal_practice_areas"("parent_id", "status", "order_index");
CREATE INDEX "legal_practice_areas_status_order_index_idx" ON "legal_practice_areas"("status", "order_index");

CREATE TABLE "jurisdictions" (
  "id" TEXT NOT NULL,
  "parent_id" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "taxonomy_status" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jurisdictions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jurisdictions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "jurisdictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "jurisdictions_code_length_check" CHECK (char_length("code") BETWEEN 2 AND 32),
  CONSTRAINT "jurisdictions_name_length_check" CHECK (char_length("name") BETWEEN 2 AND 160),
  CONSTRAINT "jurisdictions_not_own_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);
CREATE UNIQUE INDEX "jurisdictions_code_key" ON "jurisdictions"("code");
CREATE INDEX "jurisdictions_parent_id_status_idx" ON "jurisdictions"("parent_id", "status");
CREATE INDEX "jurisdictions_status_name_idx" ON "jurisdictions"("status", "name");

CREATE TABLE "webinars" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "author_profile_id" TEXT,
  "jurisdiction_id" TEXT,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "outcome_description" TEXT,
  "content_status" "webinar_content_status" NOT NULL DEFAULT 'draft',
  "visibility" "webinar_visibility" NOT NULL DEFAULT 'private',
  "freshness_status" "webinar_freshness_status" NOT NULL DEFAULT 'unknown',
  "audience_level" "webinar_audience_level",
  "target_audience" TEXT,
  "format" "webinar_format",
  "duration_minutes" INTEGER,
  "language" TEXT NOT NULL DEFAULT 'ru',
  "current_as_of" DATE,
  "disclaimer" TEXT,
  "synthetic_disclosure" TEXT,
  "media_status" "webinar_media_status" NOT NULL DEFAULT 'not_uploaded',
  "transcript_status" "webinar_transcript_status" NOT NULL DEFAULT 'not_available',
  "scenario_status" "webinar_scenario_status" NOT NULL DEFAULT 'not_available',
  "content_version" INTEGER NOT NULL DEFAULT 1,
  "superseded_by_webinar_id" TEXT,
  "legacy_compatibility" BOOLEAN NOT NULL DEFAULT false,
  "published_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinars_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinars_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinars_author_profile_scope_fkey" FOREIGN KEY ("author_profile_id", "organization_id") REFERENCES "author_profiles"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinars_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinars_title_length_check" CHECK (char_length("title") BETWEEN 3 AND 240),
  CONSTRAINT "webinars_slug_format_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 120),
  CONSTRAINT "webinars_description_length_check" CHECK ("description" IS NULL OR char_length("description") <= 10000),
  CONSTRAINT "webinars_outcome_length_check" CHECK ("outcome_description" IS NULL OR char_length("outcome_description") <= 2000),
  CONSTRAINT "webinars_target_audience_length_check" CHECK ("target_audience" IS NULL OR char_length("target_audience") <= 1000),
  CONSTRAINT "webinars_duration_minutes_check" CHECK ("duration_minutes" IS NULL OR "duration_minutes" BETWEEN 1 AND 180),
  CONSTRAINT "webinars_disclaimer_length_check" CHECK ("disclaimer" IS NULL OR char_length("disclaimer") <= 2000),
  CONSTRAINT "webinars_synthetic_disclosure_length_check" CHECK ("synthetic_disclosure" IS NULL OR char_length("synthetic_disclosure") <= 2000),
  CONSTRAINT "webinars_language_length_check" CHECK (char_length("language") BETWEEN 2 AND 20),
  CONSTRAINT "webinars_content_version_check" CHECK ("content_version" > 0),
  CONSTRAINT "webinars_not_self_superseded_check" CHECK ("superseded_by_webinar_id" IS NULL OR "superseded_by_webinar_id" <> "id")
);
CREATE UNIQUE INDEX "webinars_organization_id_slug_key" ON "webinars"("organization_id", "slug");
CREATE UNIQUE INDEX "webinars_id_organization_id_key" ON "webinars"("id", "organization_id");
CREATE INDEX "webinars_organization_id_content_status_updated_at_idx" ON "webinars"("organization_id", "content_status", "updated_at");
CREATE INDEX "webinars_author_profile_id_content_status_idx" ON "webinars"("author_profile_id", "content_status");
CREATE INDEX "webinars_jurisdiction_id_content_status_idx" ON "webinars"("jurisdiction_id", "content_status");
CREATE INDEX "webinars_visibility_content_status_published_at_idx" ON "webinars"("visibility", "content_status", "published_at");
CREATE INDEX "webinars_superseded_by_webinar_id_idx" ON "webinars"("superseded_by_webinar_id");
ALTER TABLE "webinars"
  ADD CONSTRAINT "webinars_superseded_scope_fkey"
  FOREIGN KEY ("superseded_by_webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "webinar_practice_areas" (
  "webinar_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "practice_area_id" TEXT NOT NULL,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_practice_areas_pkey" PRIMARY KEY ("webinar_id", "practice_area_id"),
  CONSTRAINT "webinar_practice_areas_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "webinar_practice_areas_practice_area_id_fkey" FOREIGN KEY ("practice_area_id") REFERENCES "legal_practice_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "webinar_practice_areas_one_primary_idx" ON "webinar_practice_areas"("webinar_id") WHERE "is_primary" = true;
CREATE INDEX "webinar_practice_areas_organization_id_practice_area_id_idx" ON "webinar_practice_areas"("organization_id", "practice_area_id");
CREATE INDEX "webinar_practice_areas_practice_area_id_is_primary_idx" ON "webinar_practice_areas"("practice_area_id", "is_primary");

CREATE TABLE "webinar_sources" (
  "id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "type" "webinar_source_type" NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT,
  "accessed_at" DATE,
  "note" TEXT,
  "order_index" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_sources_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "webinar_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_sources_title_length_check" CHECK (char_length("title") BETWEEN 2 AND 500),
  CONSTRAINT "webinar_sources_url_length_check" CHECK ("url" IS NULL OR char_length("url") <= 2000),
  CONSTRAINT "webinar_sources_note_length_check" CHECK ("note" IS NULL OR char_length("note") <= 4000),
  CONSTRAINT "webinar_sources_order_check" CHECK ("order_index" BETWEEN 0 AND 10000)
);
CREATE INDEX "webinar_sources_webinar_id_order_index_idx" ON "webinar_sources"("webinar_id", "order_index");
CREATE INDEX "webinar_sources_organization_id_type_idx" ON "webinar_sources"("organization_id", "type");

CREATE TABLE "webinar_slug_aliases" (
  "id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_slug_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_slug_aliases_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "webinar_slug_aliases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_slug_aliases_slug_format_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 120)
);
CREATE UNIQUE INDEX "webinar_slug_aliases_organization_id_slug_key" ON "webinar_slug_aliases"("organization_id", "slug");
CREATE INDEX "webinar_slug_aliases_webinar_id_created_at_idx" ON "webinar_slug_aliases"("webinar_id", "created_at");

CREATE TABLE "webinar_commands" (
  "id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "result_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webinar_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_commands_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_commands_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_commands_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webinar_commands_action_check" CHECK ("action" IN ('submit', 'publish', 'archive', 'duplicate')),
  CONSTRAINT "webinar_commands_key_length_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 191)
);
CREATE UNIQUE INDEX "webinar_commands_organization_id_action_idempotency_key_key" ON "webinar_commands"("organization_id", "action", "idempotency_key");
CREATE INDEX "webinar_commands_webinar_id_action_created_at_idx" ON "webinar_commands"("webinar_id", "action", "created_at");
CREATE INDEX "webinar_commands_requested_by_id_created_at_idx" ON "webinar_commands"("requested_by_id", "created_at");

-- One deterministic compatibility Webinar is created for every organization that already
-- owns sessions. This makes a foundation-only tenant DB migratable without cross-tenant FKs.
INSERT INTO "webinars" (
  "id", "organization_id", "slug", "title", "description", "content_status",
  "visibility", "freshness_status", "language", "media_status", "transcript_status",
  "scenario_status", "legacy_compatibility", "published_at", "created_at", "updated_at"
)
SELECT
  CASE
    WHEN ws."organization_id" = 'org_aspb' THEN 'webinar_aspb_legacy'
    ELSE 'webinar_legacy_' || md5(ws."organization_id")
  END,
  ws."organization_id",
  'legacy-webinar',
  COALESCE(MIN(ws."title"), 'Архивный вебинар'),
  'Вебинар создан compatibility-backfill без изменения исходных сессий.',
  'published',
  'unlisted',
  'unknown',
  'ru',
  'ready',
  'not_available',
  'published',
  true,
  MIN(ws."created_at"),
  MIN(ws."created_at"),
  CURRENT_TIMESTAMP
FROM "webinar_sessions" ws
GROUP BY ws."organization_id";

-- Ensure the stable ASPB default exists even on a database that had no session rows.
INSERT INTO "webinars" (
  "id", "organization_id", "slug", "title", "description", "content_status",
  "visibility", "freshness_status", "language", "media_status", "transcript_status",
  "scenario_status", "legacy_compatibility", "created_at", "updated_at"
) VALUES (
  'webinar_aspb_legacy',
  'org_aspb',
  'legacy-webinar',
  'Ежедневный вебинар АСПБ',
  'Стабильный compatibility-контейнер для существующей воронки АСПБ.',
  'published',
  'unlisted',
  'unknown',
  'ru',
  'ready',
  'not_available',
  'published',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "webinar_sessions"
  ADD COLUMN "webinar_id" TEXT,
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
  ADD COLUMN "lifecycle_status" "webinar_session_lifecycle_status" NOT NULL DEFAULT 'scheduled';

UPDATE "webinar_sessions"
SET "webinar_id" = CASE
  WHEN "organization_id" = 'org_aspb' THEN 'webinar_aspb_legacy'
  ELSE 'webinar_legacy_' || md5("organization_id")
END;

ALTER TABLE "webinar_sessions"
  ALTER COLUMN "webinar_id" SET NOT NULL,
  ALTER COLUMN "webinar_id" SET DEFAULT 'webinar_aspb_legacy';

ALTER TABLE "webinar_sessions"
  ADD CONSTRAINT "webinar_sessions_webinar_scope_fkey"
  FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "webinar_sessions" VALIDATE CONSTRAINT "webinar_sessions_webinar_scope_fkey";

-- Expanding uniqueness permits different Webinars to start at the same instant.
DROP INDEX "webinar_sessions_scheduled_at_key";
CREATE UNIQUE INDEX "webinar_sessions_webinar_id_scheduled_at_key" ON "webinar_sessions"("webinar_id", "scheduled_at");
CREATE INDEX "webinar_sessions_webinar_id_lifecycle_status_scheduled_at_idx" ON "webinar_sessions"("webinar_id", "lifecycle_status", "scheduled_at");

RESET statement_timeout;
RESET lock_timeout;
