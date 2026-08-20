\set ON_ERROR_STOP on

-- Prisma runs migration.sql in a transaction, while PostgreSQL requires each
-- CREATE INDEX CONCURRENTLY to run outside transaction blocks. This mandatory,
-- idempotent post-deploy step keeps legacy webinar/audit writes available.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webinar_sessions_organization_id_scheduled_at_idx"
  ON "webinar_sessions"("organization_id", "scheduled_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_user_id_idx"
  ON "audit_logs"("user_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_organization_id_created_at_idx"
  ON "audit_logs"("organization_id", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_correlation_id_idx"
  ON "audit_logs"("correlation_id");

RESET statement_timeout;
RESET lock_timeout;
