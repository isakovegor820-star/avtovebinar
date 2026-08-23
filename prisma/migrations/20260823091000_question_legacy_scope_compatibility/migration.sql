-- Preserve the verified legacy registration bridge while keeping every
-- Question tenant-scoped from its exact WebinarSession. A non-null
-- Registration scope is still required to match exactly.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION "aspb_enforce_question_scope"()
RETURNS trigger AS $$
DECLARE
  scoped_session "webinar_sessions"%ROWTYPE;
  scoped_registration "registrations"%ROWTYPE;
BEGIN
  SELECT * INTO scoped_session
  FROM "webinar_sessions"
  WHERE "id" = NEW."webinar_session_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question session scope is invalid';
  END IF;

  SELECT * INTO scoped_registration
  FROM "registrations"
  WHERE "id" = NEW."registration_id";

  IF NOT FOUND
    OR scoped_registration."webinar_session_id" <> scoped_session."id"
    OR scoped_registration."lead_id" <> NEW."lead_id"
    OR (scoped_registration."organization_id" IS NOT NULL
      AND scoped_registration."organization_id" <> scoped_session."organization_id")
    OR (scoped_registration."webinar_id" IS NOT NULL
      AND scoped_registration."webinar_id" <> scoped_session."webinar_id")
  THEN
    RAISE EXCEPTION 'Question registration scope is invalid';
  END IF;

  NEW."organization_id" := scoped_session."organization_id";
  NEW."webinar_id" := scoped_session."webinar_id";
  NEW."text_fingerprint" := md5(lower(regexp_replace(btrim(NEW."text"), '\s+', ' ', 'g')));

  IF TG_OP = 'UPDATE' AND NEW."moderation_status" IS NOT DISTINCT FROM OLD."moderation_status"
    AND NEW."is_answered" IS DISTINCT FROM OLD."is_answered"
  THEN
    NEW."moderation_status" := CASE WHEN NEW."is_answered" THEN 'resolved'::"question_moderation_status" ELSE 'new'::"question_moderation_status" END;
  ELSE
    NEW."is_answered" := NEW."moderation_status" = 'resolved';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

RESET statement_timeout;
RESET lock_timeout;
