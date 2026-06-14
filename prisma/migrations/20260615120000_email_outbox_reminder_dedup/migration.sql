-- Защитный дедуп существующих дублей напоминаний перед уникальным индексом: если дубли
-- появились из-за гонок до этой правки, CREATE UNIQUE INDEX иначе упал бы. NULL reminder_kind
-- (не-reminder джобы) ограничением не затрагиваются — в Postgres NULL считаются различными.
DELETE FROM "email_outbox_jobs" a
  USING "email_outbox_jobs" b
  WHERE a."reminder_kind" IS NOT NULL
    AND a."registration_id" IS NOT NULL
    AND a.ctid < b.ctid
    AND a."registration_id" = b."registration_id"
    AND a."type" = b."type"
    AND a."reminder_kind" = b."reminder_kind";

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_jobs_registration_id_type_reminder_kind_key" ON "email_outbox_jobs"("registration_id", "type", "reminder_kind");
