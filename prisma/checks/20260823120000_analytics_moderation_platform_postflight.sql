-- All violation counts must be zero.
WITH violations AS (
  SELECT report."id"
  FROM "content_reports" report
  LEFT JOIN "webinars" webinar
    ON webinar."id" = report."webinar_id" AND webinar."organization_id" = report."organization_id"
  LEFT JOIN "author_profiles" author
    ON author."id" = report."author_profile_id" AND author."organization_id" = report."organization_id"
  WHERE report."revision" < 0
     OR char_length(btrim(report."description")) NOT BETWEEN 10 AND 2000
     OR (report."target_type" = 'webinar' AND (webinar."id" IS NULL OR report."author_profile_id" IS NOT NULL))
     OR (report."target_type" = 'author_profile' AND (author."id" IS NULL OR report."webinar_id" IS NOT NULL))
), event_violations AS (
  SELECT event."id"
  FROM "content_report_events" event
  LEFT JOIN "content_reports" report
    ON report."id" = event."report_id" AND report."organization_id" = event."organization_id"
  WHERE report."id" IS NULL
     OR event."report_revision" < 0
     OR char_length(btrim(event."reason")) NOT BETWEEN 3 AND 500
), correction_violations AS (
  SELECT request."id"
  FROM "moderation_correction_requests" request
  LEFT JOIN "webinars" webinar
    ON webinar."id" = request."webinar_id" AND webinar."organization_id" = request."organization_id"
  WHERE webinar."id" IS NULL
     OR request."revision" < 0
     OR request."baseline_content_version" <= 0
     OR (request."status" = 'open' AND request."submitted_at" IS NOT NULL)
     OR (request."status" = 'submitted' AND request."submitted_at" IS NULL)
     OR (request."status" IN ('approved', 'rejected') AND (request."reviewed_at" IS NULL OR request."reviewed_by_admin_user_id" IS NULL))
), revision_violations AS (
  SELECT revision."id"
  FROM "webinar_content_revisions" revision
  LEFT JOIN "moderation_correction_requests" request
    ON request."id" = revision."correction_request_id"
   AND request."organization_id" = revision."organization_id"
   AND request."webinar_id" = revision."webinar_id"
  WHERE request."id" IS NULL OR revision."revision" <= 0 OR revision."base_content_version" <= 0
), platform_action_violations AS (
  SELECT action."id"
  FROM "moderation_platform_actions" action
  LEFT JOIN "webinars" webinar
    ON webinar."id" = action."webinar_id" AND webinar."organization_id" = action."organization_id"
  LEFT JOIN "author_profiles" author
    ON author."id" = action."author_profile_id" AND author."organization_id" = action."organization_id"
  WHERE (action."target_type" = 'webinar' AND (webinar."id" IS NULL OR action."author_profile_id" IS NOT NULL))
     OR (action."target_type" = 'author_profile' AND (author."id" IS NULL OR action."webinar_id" IS NOT NULL))
), flag_violations AS (
  SELECT flag."key" FROM "platform_feature_flags" flag
  WHERE flag."revision" <= 0 OR flag."key" !~ '^[a-z][a-z0-9_]{2,63}$'
), duplicate_case_revisions AS (
  SELECT "report_id", "report_revision"
  FROM "content_report_events"
  GROUP BY "report_id", "report_revision"
  HAVING COUNT(*) > 1
)
SELECT
  (SELECT COUNT(*) FROM violations) AS content_report_scope_violations,
  (SELECT COUNT(*) FROM event_violations) AS content_report_event_violations,
  (SELECT COUNT(*) FROM correction_violations) AS correction_state_violations,
  (SELECT COUNT(*) FROM revision_violations) AS content_revision_scope_violations,
  (SELECT COUNT(*) FROM platform_action_violations) AS platform_action_scope_violations,
  (SELECT COUNT(*) FROM flag_violations) AS feature_flag_violations,
  (SELECT COUNT(*) FROM duplicate_case_revisions) AS duplicate_case_revisions;

DO $$
DECLARE violation_count BIGINT;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM "content_reports" report
      LEFT JOIN "webinars" webinar ON webinar."id" = report."webinar_id" AND webinar."organization_id" = report."organization_id"
      LEFT JOIN "author_profiles" author ON author."id" = report."author_profile_id" AND author."organization_id" = report."organization_id"
      WHERE (report."target_type" = 'webinar' AND webinar."id" IS NULL)
         OR (report."target_type" = 'author_profile' AND author."id" IS NULL))
    +
    (SELECT COUNT(*) FROM "webinar_content_revisions" revision
      LEFT JOIN "moderation_correction_requests" request
        ON request."id" = revision."correction_request_id"
       AND request."organization_id" = revision."organization_id"
       AND request."webinar_id" = revision."webinar_id"
      WHERE request."id" IS NULL)
    +
    (SELECT COUNT(*) FROM "platform_feature_flags" WHERE "revision" <= 0)
  INTO violation_count;
  IF violation_count <> 0 THEN
    RAISE EXCEPTION 'ANA/MOD postflight failed: violations=%', violation_count;
  END IF;
END;
$$;
