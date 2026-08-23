CREATE TYPE "registration_access_policy" AS ENUM ('legacy', 'public_catalog', 'private_grant');

ALTER TABLE "registrations"
  ADD COLUMN "organization_id" TEXT,
  ADD COLUMN "webinar_id" TEXT,
  ADD COLUMN "user_id" TEXT,
  ADD COLUMN "access_policy" "registration_access_policy" NOT NULL DEFAULT 'legacy';

-- Participant identity is a platform User, never an AdminUser. Existing users
-- with the same normalized email are reused without changing their role,
-- membership, MFA or account state.
INSERT INTO "users" (
  "id",
  "email_normalized",
  "display_name",
  "kind",
  "status",
  "email_verified_at",
  "session_version",
  "created_at",
  "updated_at"
)
SELECT
  'viewer_' || md5(lower(lead."email")),
  lower(lead."email"),
  NULLIF(btrim(lead."name"), ''),
  'human'::"UserKind",
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM "registrations" verified_registration
      WHERE verified_registration."lead_id" = lead."id"
        AND verified_registration."status" = 'registered'
        AND verified_registration."email_verified_at" IS NOT NULL
    ) THEN 'active'::"UserStatus"
    ELSE 'pending'::"UserStatus"
  END,
  (
    SELECT max(verified_registration."email_verified_at")
    FROM "registrations" verified_registration
    WHERE verified_registration."lead_id" = lead."id"
      AND verified_registration."status" = 'registered'
      AND verified_registration."email_verified_at" IS NOT NULL
  ),
  1,
  lead."created_at",
  CURRENT_TIMESTAMP
FROM "leads" lead
ON CONFLICT ("email_normalized") DO NOTHING;

UPDATE "registrations" registration
SET
  "organization_id" = session."organization_id",
  "webinar_id" = session."webinar_id",
  "user_id" = participant_user."id"
FROM "webinar_sessions" session,
     "leads" lead,
     "users" participant_user
WHERE session."id" = registration."webinar_session_id"
  AND lead."id" = registration."lead_id"
  AND participant_user."email_normalized" = lower(lead."email");

CREATE UNIQUE INDEX "webinar_sessions_id_webinar_id_organization_id_key"
  ON "webinar_sessions" ("id", "webinar_id", "organization_id");

ALTER TABLE "registrations"
  ADD CONSTRAINT "registrations_scope_completeness_check"
  CHECK (
    ("organization_id" IS NULL AND "webinar_id" IS NULL AND "user_id" IS NULL AND "access_policy" = 'legacy')
    OR
    ("organization_id" IS NOT NULL AND "webinar_id" IS NOT NULL AND "user_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "registrations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "registrations_webinar_id_organization_id_fkey"
    FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "registrations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "registrations_session_scope_fkey"
    FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id")
    REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "registrations_organization_id_user_id_registered_at_idx"
  ON "registrations" ("organization_id", "user_id", "registered_at");
CREATE INDEX "registrations_organization_id_webinar_id_status_idx"
  ON "registrations" ("organization_id", "webinar_id", "status");
CREATE INDEX "registrations_user_id_webinar_session_id_idx"
  ON "registrations" ("user_id", "webinar_session_id");

CREATE TABLE "viewer_webinar_favorites" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "viewer_webinar_favorites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "viewer_webinar_favorites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "viewer_webinar_favorites_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "viewer_webinar_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "viewer_webinar_favorites_user_id_organization_id_webinar_id_key"
  ON "viewer_webinar_favorites" ("user_id", "organization_id", "webinar_id");
CREATE INDEX "viewer_webinar_favorites_organization_id_user_id_created_at_idx"
  ON "viewer_webinar_favorites" ("organization_id", "user_id", "created_at");

CREATE TABLE "viewer_webinar_progress" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "webinar_session_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "position_ms" INTEGER NOT NULL DEFAULT 0,
  "duration_ms" INTEGER,
  "last_dedup_key" TEXT,
  "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "viewer_webinar_progress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "viewer_webinar_progress_position_check" CHECK (
    "position_ms" >= 0
    AND ("duration_ms" IS NULL OR ("duration_ms" > 0 AND "position_ms" <= "duration_ms"))
  ),
  CONSTRAINT "viewer_webinar_progress_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "viewer_webinar_progress_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "viewer_webinar_progress_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "viewer_webinar_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "viewer_webinar_progress_user_id_organization_id_webinar_session_id_key"
  ON "viewer_webinar_progress" ("user_id", "organization_id", "webinar_session_id");
CREATE INDEX "viewer_webinar_progress_organization_id_user_id_updated_at_idx"
  ON "viewer_webinar_progress" ("organization_id", "user_id", "updated_at");
CREATE INDEX "viewer_webinar_progress_webinar_id_completed_at_idx"
  ON "viewer_webinar_progress" ("webinar_id", "completed_at");

CREATE TABLE "viewer_webinar_notes" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "webinar_id" TEXT NOT NULL,
  "webinar_session_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "timestamp_ms" INTEGER NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "viewer_webinar_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "viewer_webinar_notes_content_check" CHECK ("timestamp_ms" >= 0 AND char_length(btrim("body")) BETWEEN 1 AND 4000),
  CONSTRAINT "viewer_webinar_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "viewer_webinar_notes_webinar_scope_fkey" FOREIGN KEY ("webinar_id", "organization_id") REFERENCES "webinars"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "viewer_webinar_notes_session_scope_fkey" FOREIGN KEY ("webinar_session_id", "webinar_id", "organization_id") REFERENCES "webinar_sessions"("id", "webinar_id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "viewer_webinar_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "viewer_webinar_notes_organization_id_user_id_webinar_session_id_timestamp_idx"
  ON "viewer_webinar_notes" ("organization_id", "user_id", "webinar_session_id", "timestamp_ms");

CREATE TABLE "viewer_notification_preferences" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "marketing_email_enabled" BOOLEAN NOT NULL DEFAULT false,
  "marketing_telegram_enabled" BOOLEAN NOT NULL DEFAULT false,
  "service_email_enabled" BOOLEAN NOT NULL DEFAULT true,
  "service_telegram_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "viewer_notification_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "viewer_notification_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "viewer_notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "viewer_notification_preferences_user_id_organization_id_key"
  ON "viewer_notification_preferences" ("user_id", "organization_id");
CREATE INDEX "viewer_notification_preferences_organization_id_updated_at_idx"
  ON "viewer_notification_preferences" ("organization_id", "updated_at");
