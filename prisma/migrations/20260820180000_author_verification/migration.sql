CREATE TYPE "author_verification_status" AS ENUM (
  'draft',
  'pending',
  'needs_info',
  'verified',
  'rejected',
  'suspended'
);

CREATE TYPE "author_evidence_kind" AS ENUM ('license', 'diploma', 'bar_membership', 'other');

CREATE TABLE "author_profiles" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "public_name" TEXT,
  "bio" TEXT,
  "specializations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "professional_organization" TEXT,
  "region" TEXT,
  "experience" TEXT,
  "verification_status" "author_verification_status" NOT NULL DEFAULT 'draft',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "author_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "author_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "author_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "author_profiles_public_name_length_check" CHECK ("public_name" IS NULL OR char_length("public_name") BETWEEN 2 AND 160),
  CONSTRAINT "author_profiles_bio_length_check" CHECK ("bio" IS NULL OR char_length("bio") <= 5000),
  CONSTRAINT "author_profiles_professional_organization_length_check" CHECK ("professional_organization" IS NULL OR char_length("professional_organization") <= 240),
  CONSTRAINT "author_profiles_region_length_check" CHECK ("region" IS NULL OR char_length("region") <= 160),
  CONSTRAINT "author_profiles_experience_length_check" CHECK ("experience" IS NULL OR char_length("experience") <= 5000),
  CONSTRAINT "author_profiles_specializations_count_check" CHECK (cardinality("specializations") <= 30)
);

CREATE UNIQUE INDEX "author_profiles_slug_key" ON "author_profiles"("slug");
CREATE UNIQUE INDEX "author_profiles_organization_id_user_id_key" ON "author_profiles"("organization_id", "user_id");
CREATE UNIQUE INDEX "author_profiles_id_organization_id_key" ON "author_profiles"("id", "organization_id");
CREATE INDEX "author_profiles_organization_id_verification_status_idx" ON "author_profiles"("organization_id", "verification_status");
CREATE INDEX "author_profiles_user_id_idx" ON "author_profiles"("user_id");

CREATE TABLE "author_verifications" (
  "id" TEXT NOT NULL,
  "profile_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "status" "author_verification_status" NOT NULL DEFAULT 'pending',
  "submitted_by_user_id" TEXT NOT NULL,
  "reviewed_by_admin_user_id" TEXT,
  "public_comment" TEXT,
  "internal_reason" TEXT,
  "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "author_verifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "author_verifications_profile_scope_fkey" FOREIGN KEY ("profile_id", "organization_id") REFERENCES "author_profiles"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "author_verifications_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "author_verifications_reviewed_by_admin_user_id_fkey" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "author_verifications_public_comment_length_check" CHECK ("public_comment" IS NULL OR char_length("public_comment") <= 2000),
  CONSTRAINT "author_verifications_internal_reason_length_check" CHECK ("internal_reason" IS NULL OR char_length("internal_reason") <= 4000),
  CONSTRAINT "author_verifications_review_state_check" CHECK (
    ("status" = 'pending' AND "reviewed_at" IS NULL AND "reviewed_by_admin_user_id" IS NULL)
    OR ("status" <> 'pending' AND "reviewed_at" IS NOT NULL AND "reviewed_by_admin_user_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "author_verifications_id_organization_id_key" ON "author_verifications"("id", "organization_id");
CREATE UNIQUE INDEX "author_verifications_one_pending_per_profile_idx" ON "author_verifications"("profile_id") WHERE "status" = 'pending';
CREATE INDEX "author_verifications_organization_id_status_submitted_at_idx" ON "author_verifications"("organization_id", "status", "submitted_at");
CREATE INDEX "author_verifications_profile_id_submitted_at_idx" ON "author_verifications"("profile_id", "submitted_at");
CREATE INDEX "author_verifications_reviewed_by_admin_user_id_idx" ON "author_verifications"("reviewed_by_admin_user_id");

CREATE TABLE "author_verification_evidence" (
  "id" TEXT NOT NULL,
  "profile_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "verification_id" TEXT,
  "kind" "author_evidence_kind" NOT NULL,
  "original_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "checksum_sha256" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "author_verification_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "author_verification_evidence_profile_scope_fkey" FOREIGN KEY ("profile_id", "organization_id") REFERENCES "author_profiles"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "author_verification_evidence_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "author_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "author_verification_evidence_original_name_length_check" CHECK (char_length("original_name") BETWEEN 1 AND 240),
  CONSTRAINT "author_verification_evidence_size_check" CHECK ("size_bytes" BETWEEN 1 AND 5242880),
  CONSTRAINT "author_verification_evidence_checksum_check" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "author_verification_evidence_profile_id_created_at_idx" ON "author_verification_evidence"("profile_id", "created_at");
CREATE INDEX "author_verification_evidence_organization_id_verification_id_idx" ON "author_verification_evidence"("organization_id", "verification_id");
