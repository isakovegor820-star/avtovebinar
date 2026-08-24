CREATE TABLE "legal_holds" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "categories" TEXT[] NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by_admin_user_id" TEXT NOT NULL,
  "released_by_admin_user_id" TEXT,
  "released_at" TIMESTAMP(3),
  "release_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legal_holds_status_check" CHECK ("status" IN ('ACTIVE', 'RELEASED')),
  CONSTRAINT "legal_holds_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "legal_holds_window_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "legal_holds_categories_check" CHECK (cardinality("categories") > 0),
  CONSTRAINT "legal_holds_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "legal_holds_creator_fkey" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "legal_holds_releaser_fkey" FOREIGN KEY ("released_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "legal_holds_org_status_window_idx" ON "legal_holds"("organization_id", "status", "starts_at", "ends_at");
