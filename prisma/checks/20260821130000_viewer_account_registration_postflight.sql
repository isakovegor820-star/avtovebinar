SELECT COUNT(*) AS scoped_registrations_with_missing_links
FROM "registrations"
WHERE "access_policy" <> 'legacy'
  AND ("organization_id" IS NULL OR "webinar_id" IS NULL OR "user_id" IS NULL);

SELECT COUNT(*) AS registration_session_scope_mismatches
FROM "registrations" registration
JOIN "webinar_sessions" session ON session."id" = registration."webinar_session_id"
WHERE registration."organization_id" IS NOT NULL
  AND (
    registration."organization_id" <> session."organization_id"
    OR registration."webinar_id" <> session."webinar_id"
  );

SELECT COUNT(*) AS viewer_progress_scope_mismatches
FROM "viewer_webinar_progress" progress
JOIN "webinar_sessions" session ON session."id" = progress."webinar_session_id"
WHERE progress."organization_id" <> session."organization_id"
   OR progress."webinar_id" <> session."webinar_id";

SELECT COUNT(*) AS viewer_note_scope_mismatches
FROM "viewer_webinar_notes" note
JOIN "webinar_sessions" session ON session."id" = note."webinar_session_id"
WHERE note."organization_id" <> session."organization_id"
   OR note."webinar_id" <> session."webinar_id";

SELECT COUNT(*) AS duplicate_viewer_favorites
FROM (
  SELECT "user_id", "organization_id", "webinar_id"
  FROM "viewer_webinar_favorites"
  GROUP BY "user_id", "organization_id", "webinar_id"
  HAVING COUNT(*) > 1
) duplicates;
