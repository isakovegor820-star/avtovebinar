-- TEN-008 expand migration. Existing AdminUser MFA remains unchanged.
ALTER TABLE "users"
  ADD COLUMN "mfa_secret_encrypted" TEXT,
  ADD COLUMN "mfa_enabled_at" TIMESTAMP(3),
  ADD COLUMN "mfa_enrollment_expires_at" TIMESTAMP(3);

ALTER TABLE "user_sessions"
  ADD COLUMN "mfa_verified_at" TIMESTAMP(3);

ALTER TABLE "users"
  ADD CONSTRAINT "users_mfa_enabled_requires_secret_check"
  CHECK ("mfa_enabled_at" IS NULL OR "mfa_secret_encrypted" IS NOT NULL);
