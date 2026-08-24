-- Some legacy registrations recorded room entry only in the immutable event log.
-- Backfill one idempotent factor per registration without inventing an entry time.
INSERT INTO "crm_score_factors" (
  "id", "organization_id", "contact_id", "signal_code",
  "source_entity_type", "source_entity_id", "dedup_key", "occurred_at", "created_at"
)
SELECT
  'score_factor_' || md5(registration."organization_id" || ':room:' || registration."id"),
  registration."organization_id",
  registration."crm_contact_id",
  'room_entered',
  'registration',
  registration."id",
  'score:room_entered:registration:' || registration."id",
  MIN(event."created_at"),
  CURRENT_TIMESTAMP
FROM "registrations" registration
JOIN "events" event
  ON event."registration_id" = registration."id"
 AND event."event_name" IN ('room_entered', 'webinar_room_open')
WHERE registration."organization_id" IS NOT NULL
  AND registration."crm_contact_id" IS NOT NULL
  AND registration."room_entered_at" IS NULL
GROUP BY registration."organization_id", registration."crm_contact_id", registration."id"
ON CONFLICT ("organization_id", "dedup_key") DO NOTHING;
