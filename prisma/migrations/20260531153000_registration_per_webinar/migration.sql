-- Ensure one participant has only one registration per webinar session.
-- Existing duplicate rows are merged into the earliest registration before the unique index is added.

CREATE TEMP TABLE "_registration_dedup" AS
SELECT
  "id",
  FIRST_VALUE("id") OVER (
    PARTITION BY "lead_id", "webinar_session_id"
    ORDER BY "registered_at" ASC, "created_at" ASC, "id" ASC
  ) AS "keep_id"
FROM "registrations";

UPDATE "questions"
SET "registration_id" = "_registration_dedup"."keep_id"
FROM "_registration_dedup"
WHERE "questions"."registration_id" = "_registration_dedup"."id"
  AND "_registration_dedup"."id" <> "_registration_dedup"."keep_id";

UPDATE "events"
SET "registration_id" = "_registration_dedup"."keep_id"
FROM "_registration_dedup"
WHERE "events"."registration_id" = "_registration_dedup"."id"
  AND "_registration_dedup"."id" <> "_registration_dedup"."keep_id";

UPDATE "partner_applications"
SET "registration_id" = "_registration_dedup"."keep_id"
FROM "_registration_dedup"
WHERE "partner_applications"."registration_id" = "_registration_dedup"."id"
  AND "_registration_dedup"."id" <> "_registration_dedup"."keep_id";

UPDATE "registration_tokens"
SET "registration_id" = "_registration_dedup"."keep_id"
FROM "_registration_dedup"
WHERE "registration_tokens"."registration_id" = "_registration_dedup"."id"
  AND "_registration_dedup"."id" <> "_registration_dedup"."keep_id";

UPDATE "registrations" AS "keep"
SET
  "success_viewed_at" = COALESCE("keep"."success_viewed_at", "merged"."success_viewed_at"),
  "room_entered_at" = COALESCE("keep"."room_entered_at", "merged"."room_entered_at"),
  "telegram_clicked_at" = COALESCE("keep"."telegram_clicked_at", "merged"."telegram_clicked_at"),
  "email_sent_at" = COALESCE("keep"."email_sent_at", "merged"."email_sent_at"),
  "reminder_sent_at" = COALESCE("keep"."reminder_sent_at", "merged"."reminder_sent_at"),
  "confirmation_sent_at" = COALESCE("keep"."confirmation_sent_at", "merged"."confirmation_sent_at"),
  "reminder_24h_sent_at" = COALESCE("keep"."reminder_24h_sent_at", "merged"."reminder_24h_sent_at"),
  "reminder_3h_sent_at" = COALESCE("keep"."reminder_3h_sent_at", "merged"."reminder_3h_sent_at"),
  "reminder_30m_sent_at" = COALESCE("keep"."reminder_30m_sent_at", "merged"."reminder_30m_sent_at"),
  "telegram_reminder_24h_sent_at" = COALESCE("keep"."telegram_reminder_24h_sent_at", "merged"."telegram_reminder_24h_sent_at"),
  "telegram_reminder_3h_sent_at" = COALESCE("keep"."telegram_reminder_3h_sent_at", "merged"."telegram_reminder_3h_sent_at"),
  "telegram_reminder_30m_sent_at" = COALESCE("keep"."telegram_reminder_30m_sent_at", "merged"."telegram_reminder_30m_sent_at"),
  "telegram_followup_sent_at" = COALESCE("keep"."telegram_followup_sent_at", "merged"."telegram_followup_sent_at"),
  "is_hot" = "keep"."is_hot" OR "merged"."is_hot",
  "next_contact_at" = COALESCE("keep"."next_contact_at", "merged"."next_contact_at"),
  "manager_note" = COALESCE("keep"."manager_note", "merged"."manager_note")
FROM (
  SELECT
    "_registration_dedup"."keep_id",
    MAX("registrations"."success_viewed_at") AS "success_viewed_at",
    MAX("registrations"."room_entered_at") AS "room_entered_at",
    MAX("registrations"."telegram_clicked_at") AS "telegram_clicked_at",
    MAX("registrations"."email_sent_at") AS "email_sent_at",
    MAX("registrations"."reminder_sent_at") AS "reminder_sent_at",
    MAX("registrations"."confirmation_sent_at") AS "confirmation_sent_at",
    MAX("registrations"."reminder_24h_sent_at") AS "reminder_24h_sent_at",
    MAX("registrations"."reminder_3h_sent_at") AS "reminder_3h_sent_at",
    MAX("registrations"."reminder_30m_sent_at") AS "reminder_30m_sent_at",
    MAX("registrations"."telegram_reminder_24h_sent_at") AS "telegram_reminder_24h_sent_at",
    MAX("registrations"."telegram_reminder_3h_sent_at") AS "telegram_reminder_3h_sent_at",
    MAX("registrations"."telegram_reminder_30m_sent_at") AS "telegram_reminder_30m_sent_at",
    MAX("registrations"."telegram_followup_sent_at") AS "telegram_followup_sent_at",
    BOOL_OR("registrations"."is_hot") AS "is_hot",
    MIN("registrations"."next_contact_at") AS "next_contact_at",
    MAX("registrations"."manager_note") AS "manager_note"
  FROM "_registration_dedup"
  JOIN "registrations" ON "registrations"."id" = "_registration_dedup"."id"
  WHERE "_registration_dedup"."id" <> "_registration_dedup"."keep_id"
  GROUP BY "_registration_dedup"."keep_id"
) AS "merged"
WHERE "keep"."id" = "merged"."keep_id";

DELETE FROM "registrations"
USING "_registration_dedup"
WHERE "registrations"."id" = "_registration_dedup"."id"
  AND "_registration_dedup"."id" <> "_registration_dedup"."keep_id";

DROP TABLE "_registration_dedup";

CREATE UNIQUE INDEX "registrations_lead_id_webinar_session_id_key"
  ON "registrations"("lead_id", "webinar_session_id");
