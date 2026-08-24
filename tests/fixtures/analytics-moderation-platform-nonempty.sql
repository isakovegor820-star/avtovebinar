-- Applied after 20260823110000 and before 20260823120000 in an isolated schema.
-- The rows are deliberately non-empty legacy/current-domain data; the expand
-- migration must add defaults and new empty case tables without rewriting them.
INSERT INTO "organizations" ("id", "name", "slug", "updated_at")
VALUES ('migration_fixture_org', 'Migration fixture tenant', 'migration-fixture-tenant', CURRENT_TIMESTAMP);

INSERT INTO "legal_practice_areas" ("id", "slug", "name")
VALUES ('migration_fixture_practice', 'migration-fixture-practice', 'Migration fixture practice');

INSERT INTO "jurisdictions" ("id", "code", "name")
VALUES ('migration_fixture_jurisdiction', 'MIG-FIX', 'Migration fixture jurisdiction');

INSERT INTO "webinars" ("id", "organization_id", "slug", "title")
VALUES ('migration_fixture_webinar', 'migration_fixture_org', 'migration-fixture-webinar', 'Migration fixture Webinar');

INSERT INTO "events" ("id", "event_name")
VALUES ('migration_fixture_legacy_event', 'page_view');

CREATE TEMP TABLE "analytics_moderation_fixture_counts" AS
SELECT
  (SELECT COUNT(*) FROM "organizations") AS organizations,
  (SELECT COUNT(*) FROM "webinars") AS webinars,
  (SELECT COUNT(*) FROM "events") AS events;
