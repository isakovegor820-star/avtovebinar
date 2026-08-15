ALTER TABLE "admin_users"
  ADD COLUMN "mfa_secret_encrypted" TEXT,
  ADD COLUMN "mfa_enabled_at" TIMESTAMP(3),
  ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "leads"
  ADD COLUMN "marketing_email_consent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "marketing_telegram_consent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "marketing_email_consent_at" TIMESTAMP(3),
  ADD COLUMN "marketing_telegram_consent_at" TIMESTAMP(3),
  ADD COLUMN "personal_data_consent_revoked_at" TIMESTAMP(3),
  ADD COLUMN "personal_data_revocation_channel" TEXT,
  ADD COLUMN "personal_data_revocation_reason" TEXT,
  ADD COLUMN "marketing_email_revoked_at" TIMESTAMP(3),
  ADD COLUMN "marketing_email_revocation_channel" TEXT,
  ADD COLUMN "marketing_email_revocation_reason" TEXT,
  ADD COLUMN "marketing_telegram_revoked_at" TIMESTAMP(3),
  ADD COLUMN "marketing_telegram_revocation_channel" TEXT,
  ADD COLUMN "marketing_telegram_revocation_reason" TEXT;

CREATE TABLE "email_outbox_dead_letters" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "payload_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_outbox_dead_letters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_outbox_dead_letters_job_id_key" ON "email_outbox_dead_letters"("job_id");
CREATE INDEX "email_outbox_dead_letters_created_at_idx" ON "email_outbox_dead_letters"("created_at");

ALTER TABLE "telegram_broadcast_jobs"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'marketing_telegram',
  ADD COLUMN "recipient_snapshot" JSONB,
  ADD COLUMN "consent_document_id" TEXT,
  ADD COLUMN "consent_document_version" TEXT,
  ADD COLUMN "initiated_by_id" TEXT,
  ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "telegram_broadcast_jobs_idempotency_key_key" ON "telegram_broadcast_jobs"("idempotency_key");
CREATE INDEX "telegram_broadcast_jobs_initiated_by_id_idx" ON "telegram_broadcast_jobs"("initiated_by_id");
ALTER TABLE "telegram_broadcast_jobs"
  ADD CONSTRAINT "telegram_broadcast_jobs_initiated_by_id_fkey"
  FOREIGN KEY ("initiated_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "questions"
  ADD COLUMN "show_to_participants" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "display_mode" TEXT NOT NULL DEFAULT 'pseudonym',
  ADD COLUMN "published_name" TEXT,
  ADD COLUMN "publication_consent_record_id" TEXT;
CREATE UNIQUE INDEX "questions_publication_consent_record_id_key" ON "questions"("publication_consent_record_id");

CREATE TABLE "consent_records" (
  "id" TEXT NOT NULL,
  "lead_id" TEXT,
  "registration_id" TEXT,
  "question_id" TEXT,
  "subject_ref_hash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "document_version" TEXT NOT NULL,
  "document_hash" TEXT NOT NULL,
  "document_effective_at" TIMESTAMP(3) NOT NULL,
  "purposes" JSONB NOT NULL,
  "data_categories" JSONB NOT NULL,
  "operations" JSONB NOT NULL,
  "retention_term" TEXT NOT NULL,
  "channels" JSONB NOT NULL,
  "source_form" TEXT NOT NULL,
  "ip_hash" TEXT,
  "user_agent" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revocation_channel" TEXT,
  "revocation_reason" TEXT,
  "revoked_consent_id" TEXT,
  CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "consent_records_lead_id_kind_occurred_at_idx" ON "consent_records"("lead_id", "kind", "occurred_at");
CREATE INDEX "consent_records_registration_id_kind_idx" ON "consent_records"("registration_id", "kind");
CREATE INDEX "consent_records_question_id_idx" ON "consent_records"("question_id");
CREATE INDEX "consent_records_document_id_document_version_idx" ON "consent_records"("document_id", "document_version");
CREATE INDEX "consent_records_revoked_consent_id_idx" ON "consent_records"("revoked_consent_id");
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_revoked_consent_id_fkey" FOREIGN KEY ("revoked_consent_id") REFERENCES "consent_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "questions" ADD CONSTRAINT "questions_publication_consent_record_id_fkey" FOREIGN KEY ("publication_consent_record_id") REFERENCES "consent_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "legal_acceptances" (
  "id" TEXT NOT NULL,
  "lead_id" TEXT,
  "registration_id" TEXT,
  "subject_ref_hash" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "document_version" TEXT NOT NULL,
  "document_hash" TEXT NOT NULL,
  "document_effective_at" TIMESTAMP(3) NOT NULL,
  "source_form" TEXT NOT NULL,
  "ip_hash" TEXT,
  "user_agent" TEXT,
  "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "legal_acceptances_lead_id_document_id_accepted_at_idx" ON "legal_acceptances"("lead_id", "document_id", "accepted_at");
CREATE INDEX "legal_acceptances_registration_id_idx" ON "legal_acceptances"("registration_id");
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "telegram_broadcast_recipients" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "lead_id" TEXT,
  "chat_id" TEXT NOT NULL,
  "consent_record_id" TEXT,
  "consent_document_version" TEXT NOT NULL,
  "inclusion_reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "unsubscribed_before_send_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_broadcast_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "telegram_broadcast_recipients_job_id_chat_id_key" ON "telegram_broadcast_recipients"("job_id", "chat_id");
CREATE INDEX "telegram_broadcast_recipients_job_id_status_created_at_idx" ON "telegram_broadcast_recipients"("job_id", "status", "created_at");
CREATE INDEX "telegram_broadcast_recipients_lead_id_idx" ON "telegram_broadcast_recipients"("lead_id");
CREATE INDEX "telegram_broadcast_recipients_consent_record_id_idx" ON "telegram_broadcast_recipients"("consent_record_id");
ALTER TABLE "telegram_broadcast_recipients" ADD CONSTRAINT "telegram_broadcast_recipients_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "telegram_broadcast_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_broadcast_recipients" ADD CONSTRAINT "telegram_broadcast_recipients_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_broadcast_recipients" ADD CONSTRAINT "telegram_broadcast_recipients_consent_record_id_fkey" FOREIGN KEY ("consent_record_id") REFERENCES "consent_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "retention_runs" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "policy_version" TEXT NOT NULL,
  "cutoff_json" JSONB NOT NULL,
  "result_json" JSONB,
  "error" TEXT,
  CONSTRAINT "retention_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "retention_runs_started_at_idx" ON "retention_runs"("started_at");
CREATE INDEX "retention_runs_status_started_at_idx" ON "retention_runs"("status", "started_at");

CREATE OR REPLACE FUNCTION prevent_immutable_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable compliance evidence cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_records_immutable
BEFORE UPDATE OR DELETE ON "consent_records"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_evidence_mutation();

CREATE TRIGGER legal_acceptances_immutable
BEFORE UPDATE OR DELETE ON "legal_acceptances"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_evidence_mutation();
