ALTER TABLE "registrations"
  ADD COLUMN "is_hot" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "registrations_is_hot_idx" ON "registrations"("is_hot");
