-- ANA-001..ANA-005, ANA-007 and MOD-001..MOD-005 additive foundation.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TYPE "moderation_report_category" AS ENUM ('content', 'author', 'rights');
CREATE TYPE "moderation_target_type" AS ENUM ('webinar', 'author_profile');
CREATE TYPE "moderation_case_status" AS ENUM ('new', 'in_review', 'action_required', 'resolved', 'rejected');
CREATE TYPE "moderation_correction_status" AS ENUM ('open', 'submitted', 'approved', 'rejected');
CREATE TYPE "moderation_visibility_decision" AS ENUM ('keep_published', 'hide_until_approved');
CREATE TYPE "moderation_revision_status" AS ENUM ('submitted', 'approved', 'rejected');

ALTER TABLE "organizations" ADD COLUMN "platform_revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "legal_practice_areas" ADD COLUMN "platform_revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "jurisdictions" ADD COLUMN "platform_revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "author_profiles" ADD COLUMN "moderation_revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "webinars" ADD COLUMN "moderation_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "organizations" ADD CONSTRAINT "organizations_platform_revision_check" CHECK ("platform_revision" > 0);
ALTER TABLE "legal_practice_areas" ADD CONSTRAINT "legal_practice_areas_platform_revision_check" CHECK ("platform_revision" > 0);
ALTER TABLE "jurisdictions" ADD CONSTRAINT "jurisdictions_platform_revision_check" CHECK ("platform_revision" > 0);
ALTER TABLE "author_profiles" ADD CONSTRAINT "author_profiles_moderation_revision_check" CHECK ("moderation_revision" >= 0);
ALTER TABLE "webinars" ADD CONSTRAINT "webinars_moderation_revision_check" CHECK ("moderation_revision" >= 0);

CREATE TABLE "content_reports" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "target_type" "moderation_target_type" NOT NULL,
  "webinar_id" TEXT,
  "author_profile_id" TEXT,
  "category" "moderation_report_category" NOT NULL,
  "description" TEXT NOT NULL,
  "reporter_user_id" TEXT,
  "reporter_contact_hash" TEXT,
  "status" "moderation_case_status" NOT NULL DEFAULT 'new',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_reports_description_check" CHECK (char_length(btrim("description")) BETWEEN 10 AND 2000),
  CONSTRAINT "content_reports_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "content_reports_correlation_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT "content_reports_contact_hash_check" CHECK ("reporter_contact_hash" IS NULL OR "reporter_contact_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "content_reports_target_check" CHECK (
    ("target_type" = 'webinar' AND "webinar_id" IS NOT NULL AND "author_profile_id" IS NULL)
    OR ("target_type" = 'author_profile' AND "webinar_id" IS NULL AND "author_profile_id" IS NOT NULL)
  ),
  CONSTRAINT "content_reports_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "content_reports_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "content_reports_author_scope_fkey" FOREIGN KEY ("author_profile_id", "organization_id") REFERENCES "author_profiles"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "content_reports_reporter_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "content_reports_id_org_key" ON "content_reports"("id", "organization_id");
CREATE INDEX "content_reports_org_status_created_idx" ON "content_reports"("organization_id", "status", "created_at");
CREATE INDEX "content_reports_webinar_status_created_idx" ON "content_reports"("webinar_id", "status", "created_at");
CREATE INDEX "content_reports_author_status_created_idx" ON "content_reports"("author_profile_id", "status", "created_at");

CREATE TABLE "content_report_events" (
  "id" TEXT NOT NULL,
  "report_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "from_status" "moderation_case_status",
  "to_status" "moderation_case_status" NOT NULL,
  "actor_admin_user_id" TEXT,
  "reason" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "report_revision" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_report_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_report_events_reason_check" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "content_report_events_revision_check" CHECK ("report_revision" >= 0),
  CONSTRAINT "content_report_events_correlation_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT "content_report_events_report_scope_fkey" FOREIGN KEY ("report_id", "organization_id") REFERENCES "content_reports"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "content_report_events_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "content_report_events_actor_fkey" FOREIGN KEY ("actor_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "content_report_events_report_revision_key" ON "content_report_events"("report_id", "report_revision");
CREATE INDEX "content_report_events_org_created_idx" ON "content_report_events"("organization_id", "created_at");
CREATE INDEX "content_report_events_actor_created_idx" ON "content_report_events"("actor_admin_user_id", "created_at");

CREATE TABLE "moderation_correction_requests" (
  "id" TEXT NOT NULL,
  "report_id" TEXT,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "requested_by_admin_user_id" TEXT NOT NULL,
  "reviewed_by_admin_user_id" TEXT,
  "reason" TEXT NOT NULL,
  "review_reason" TEXT,
  "visibility_decision" "moderation_visibility_decision" NOT NULL,
  "status" "moderation_correction_status" NOT NULL DEFAULT 'open',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "baseline_content_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submitted_at" TIMESTAMP(3),
  "reviewed_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "moderation_correction_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "moderation_correction_requests_reason_check" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "moderation_correction_requests_review_reason_check" CHECK ("review_reason" IS NULL OR char_length(btrim("review_reason")) BETWEEN 3 AND 500),
  CONSTRAINT "moderation_correction_requests_revision_check" CHECK ("revision" >= 0 AND "baseline_content_version" > 0),
  CONSTRAINT "moderation_correction_requests_state_check" CHECK (
    ("status" = 'open' AND "submitted_at" IS NULL AND "reviewed_at" IS NULL AND "reviewed_by_admin_user_id" IS NULL AND "review_reason" IS NULL)
    OR ("status" = 'submitted' AND "submitted_at" IS NOT NULL AND "reviewed_at" IS NULL AND "reviewed_by_admin_user_id" IS NULL AND "review_reason" IS NULL)
    OR ("status" IN ('approved', 'rejected') AND "submitted_at" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "reviewed_by_admin_user_id" IS NOT NULL AND "review_reason" IS NOT NULL)
  ),
  CONSTRAINT "moderation_correction_requests_report_scope_fkey" FOREIGN KEY ("report_id", "organization_id") REFERENCES "content_reports"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "moderation_correction_requests_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "moderation_correction_requests_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "moderation_correction_requests_requester_fkey" FOREIGN KEY ("requested_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT,
  CONSTRAINT "moderation_correction_requests_reviewer_fkey" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "moderation_correction_requests_id_org_key" ON "moderation_correction_requests"("id", "organization_id");
CREATE INDEX "moderation_correction_requests_org_status_created_idx" ON "moderation_correction_requests"("organization_id", "status", "created_at");
CREATE INDEX "moderation_correction_requests_webinar_status_created_idx" ON "moderation_correction_requests"("webinar_id", "status", "created_at");
CREATE INDEX "moderation_correction_requests_report_idx" ON "moderation_correction_requests"("report_id");

CREATE TABLE "webinar_content_revisions" (
  "id" TEXT NOT NULL,
  "correction_request_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "base_content_version" INTEGER NOT NULL,
  "payload_json" JSONB NOT NULL,
  "status" "moderation_revision_status" NOT NULL DEFAULT 'submitted',
  "created_by_user_id" TEXT NOT NULL,
  "reviewed_by_admin_user_id" TEXT,
  "review_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_at" TIMESTAMP(3),
  CONSTRAINT "webinar_content_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webinar_content_revisions_revision_check" CHECK ("revision" > 0 AND "base_content_version" > 0),
  CONSTRAINT "webinar_content_revisions_payload_check" CHECK (jsonb_typeof("payload_json") = 'object' AND octet_length("payload_json"::text) <= 16384),
  CONSTRAINT "webinar_content_revisions_review_check" CHECK (
    ("status" = 'submitted' AND "reviewed_by_admin_user_id" IS NULL AND "review_reason" IS NULL AND "reviewed_at" IS NULL)
    OR ("status" IN ('approved', 'rejected') AND "reviewed_by_admin_user_id" IS NOT NULL AND char_length(btrim("review_reason")) BETWEEN 3 AND 500 AND "reviewed_at" IS NOT NULL)
  ),
  CONSTRAINT "webinar_content_revisions_request_scope_fkey" FOREIGN KEY ("correction_request_id", "organization_id") REFERENCES "moderation_correction_requests"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "webinar_content_revisions_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "webinar_content_revisions_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "webinar_content_revisions_creator_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "webinar_content_revisions_reviewer_fkey" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "webinar_content_revisions_request_revision_key" ON "webinar_content_revisions"("correction_request_id", "revision");
CREATE UNIQUE INDEX "webinar_content_revisions_id_org_key" ON "webinar_content_revisions"("id", "organization_id");
CREATE INDEX "webinar_content_revisions_org_webinar_status_created_idx" ON "webinar_content_revisions"("organization_id", "webinar_id", "status", "created_at");

CREATE TABLE "moderation_platform_actions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "target_type" "moderation_target_type" NOT NULL,
  "webinar_id" TEXT,
  "author_profile_id" TEXT,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "before_json" JSONB NOT NULL,
  "after_json" JSONB NOT NULL,
  "actor_admin_user_id" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "reverses_action_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "moderation_platform_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "moderation_platform_actions_target_check" CHECK (
    ("target_type" = 'webinar' AND "webinar_id" IS NOT NULL AND "author_profile_id" IS NULL)
    OR ("target_type" = 'author_profile' AND "webinar_id" IS NULL AND "author_profile_id" IS NOT NULL)
  ),
  CONSTRAINT "moderation_platform_actions_action_check" CHECK ("action" IN ('unpublish_webinar', 'suspend_author', 'restore_webinar', 'restore_author')),
  CONSTRAINT "moderation_platform_actions_reason_check" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "moderation_platform_actions_json_check" CHECK (jsonb_typeof("before_json") = 'object' AND jsonb_typeof("after_json") = 'object'),
  CONSTRAINT "moderation_platform_actions_correlation_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT "moderation_platform_actions_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "moderation_platform_actions_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "moderation_platform_actions_author_scope_fkey" FOREIGN KEY ("author_profile_id", "organization_id") REFERENCES "author_profiles"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "moderation_platform_actions_actor_fkey" FOREIGN KEY ("actor_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT,
  CONSTRAINT "moderation_platform_actions_reversal_fkey" FOREIGN KEY ("reverses_action_id") REFERENCES "moderation_platform_actions"("id") ON DELETE RESTRICT
);
CREATE INDEX "moderation_platform_actions_org_created_idx" ON "moderation_platform_actions"("organization_id", "created_at");
CREATE INDEX "moderation_platform_actions_webinar_created_idx" ON "moderation_platform_actions"("webinar_id", "created_at");
CREATE INDEX "moderation_platform_actions_author_created_idx" ON "moderation_platform_actions"("author_profile_id", "created_at");
CREATE INDEX "moderation_platform_actions_actor_created_idx" ON "moderation_platform_actions"("actor_admin_user_id", "created_at");
CREATE UNIQUE INDEX "moderation_platform_actions_one_reversal_key" ON "moderation_platform_actions"("reverses_action_id") WHERE "reverses_action_id" IS NOT NULL;

CREATE TABLE "platform_feature_flags" (
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "description" TEXT NOT NULL,
  "updated_by_admin_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_feature_flags_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "platform_feature_flags_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT "platform_feature_flags_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "platform_feature_flags_description_check" CHECK (char_length(btrim("description")) BETWEEN 3 AND 500),
  CONSTRAINT "platform_feature_flags_updater_fkey" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT
);
CREATE INDEX "platform_feature_flags_enabled_updated_idx" ON "platform_feature_flags"("enabled", "updated_at");
INSERT INTO "platform_feature_flags" ("key", "enabled", "revision", "description", "updated_at") VALUES
  ('analytics_dashboard', FALSE, 1, 'Tenant analytics UI and reporting projection.', CURRENT_TIMESTAMP),
  ('public_reporting', FALSE, 1, 'Public content and author report submission.', CURRENT_TIMESTAMP),
  ('moderation_actions', FALSE, 1, 'Platform moderation enforcement actions.', CURRENT_TIMESTAMP),
  ('provider_jobs', FALSE, 1, 'Provider-backed jobs; changing this flag never enqueues work.', CURRENT_TIMESTAMP);

CREATE TABLE "platform_config_changes" (
  "id" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "before_json" JSONB NOT NULL,
  "after_json" JSONB NOT NULL,
  "target_revision" INTEGER NOT NULL,
  "actor_admin_user_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "rolls_back_change_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_config_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_config_changes_target_check" CHECK ("target_type" IN ('organization', 'practice_area', 'jurisdiction', 'feature_flag')),
  CONSTRAINT "platform_config_changes_operation_check" CHECK ("operation" IN ('update', 'rollback')),
  CONSTRAINT "platform_config_changes_revision_check" CHECK ("target_revision" > 0),
  CONSTRAINT "platform_config_changes_reason_check" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "platform_config_changes_json_check" CHECK (jsonb_typeof("before_json") = 'object' AND jsonb_typeof("after_json") = 'object'),
  CONSTRAINT "platform_config_changes_correlation_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT "platform_config_changes_actor_fkey" FOREIGN KEY ("actor_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT,
  CONSTRAINT "platform_config_changes_rollback_fkey" FOREIGN KEY ("rolls_back_change_id") REFERENCES "platform_config_changes"("id") ON DELETE RESTRICT
);
CREATE INDEX "platform_config_changes_target_created_idx" ON "platform_config_changes"("target_type", "target_id", "created_at");
CREATE INDEX "platform_config_changes_actor_created_idx" ON "platform_config_changes"("actor_admin_user_id", "created_at");
CREATE UNIQUE INDEX "platform_config_changes_one_rollback_key" ON "platform_config_changes"("rolls_back_change_id") WHERE "rolls_back_change_id" IS NOT NULL;

-- Extend the accepted v1 taxonomy without changing the ANA-006 envelope.
ALTER TABLE "events" DROP CONSTRAINT "events_v1_known_event_type_check";
ALTER TABLE "events" ADD CONSTRAINT "events_v1_known_event_type_check" CHECK (
  "schema_version" = 0 OR "event_name" IN (
    'page_view',
    'registration_click', 'registration_form_open', 'registration_submit', 'registration_success',
    'telegram_click', 'telegram_subscribe',
    'webinar_room_open', 'webinar_room_waiting', 'viewer_heartbeat',
    'video_start', 'video_progress_25', 'video_progress_50', 'video_progress_75', 'video_finish',
    'recordings_open', 'recording_open', 'recording_play',
    'recording_progress_25', 'recording_progress_50', 'recording_progress_75', 'recording_finish',
    'recording_cta_click', 'chapter_open', 'transcript_search',
    'question_submit', 'question_submit_attempt', 'question_submitted', 'question_submit_error',
    'partner_application_submit', 'partner_application_submitted', 'partner_application_error',
    'partner_form_opened', 'partner_request_click', 'participant_login_request',
    'admin_manual_telegram_reminder', 'telegram_broadcast', 'telegram_news_broadcast',
    'telegram_broadcast_completed', 'telegram_repeat_start', 'telegram_start_without_registration',
    'telegram_participant_command', 'telegram_consultant_start',
    'telegram_consultant_contact_request', 'telegram_consultant_message'
  )
);

CREATE FUNCTION aspb_protect_moderation_history()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'moderation history is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "content_report_events_immutable"
BEFORE UPDATE OR DELETE ON "content_report_events"
FOR EACH ROW EXECUTE FUNCTION aspb_protect_moderation_history();
CREATE TRIGGER "moderation_platform_actions_immutable"
BEFORE UPDATE OR DELETE ON "moderation_platform_actions"
FOR EACH ROW EXECUTE FUNCTION aspb_protect_moderation_history();
CREATE TRIGGER "platform_config_changes_immutable"
BEFORE UPDATE OR DELETE ON "platform_config_changes"
FOR EACH ROW EXECUTE FUNCTION aspb_protect_moderation_history();

CREATE FUNCTION aspb_protect_content_report_evidence()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content report cannot be physically deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."target_type" IS DISTINCT FROM OLD."target_type"
    OR NEW."webinar_id" IS DISTINCT FROM OLD."webinar_id"
    OR NEW."author_profile_id" IS DISTINCT FROM OLD."author_profile_id"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."reporter_user_id" IS DISTINCT FROM OLD."reporter_user_id"
    OR NEW."reporter_contact_hash" IS DISTINCT FROM OLD."reporter_contact_hash"
    OR NEW."correlation_id" IS DISTINCT FROM OLD."correlation_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'content report evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "content_reports_protect_evidence"
BEFORE UPDATE OR DELETE ON "content_reports"
FOR EACH ROW EXECUTE FUNCTION aspb_protect_content_report_evidence();

CREATE FUNCTION aspb_validate_moderation_scope()
RETURNS trigger AS $$
DECLARE request_scope RECORD;
BEGIN
  IF TG_TABLE_NAME = 'webinar_content_revisions' THEN
    SELECT "organization_id", "webinar_id" INTO request_scope
    FROM "moderation_correction_requests" WHERE "id" = NEW."correction_request_id";
    IF NOT FOUND OR request_scope."organization_id" IS DISTINCT FROM NEW."organization_id"
      OR request_scope."webinar_id" IS DISTINCT FROM NEW."webinar_id" THEN
      RAISE EXCEPTION 'moderation revision scope is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "webinar_content_revisions_scope_guard"
BEFORE INSERT OR UPDATE ON "webinar_content_revisions"
FOR EACH ROW EXECUTE FUNCTION aspb_validate_moderation_scope();

RESET statement_timeout;
RESET lock_timeout;
