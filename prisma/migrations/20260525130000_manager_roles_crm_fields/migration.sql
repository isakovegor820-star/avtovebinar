ALTER TABLE "registrations" ADD COLUMN "assigned_manager_id" TEXT;
ALTER TABLE "registrations" ADD COLUMN "next_contact_at" TIMESTAMP(3);

ALTER TABLE "partner_applications" ADD COLUMN "assigned_manager_id" TEXT;
ALTER TABLE "partner_applications" ADD COLUMN "next_contact_at" TIMESTAMP(3);
ALTER TABLE "partner_applications" ADD COLUMN "contract_sent_at" TIMESTAMP(3);
ALTER TABLE "partner_applications" ADD COLUMN "contract_signed_at" TIMESTAMP(3);
ALTER TABLE "partner_applications" ADD COLUMN "lost_reason" TEXT;

CREATE INDEX "registrations_assigned_manager_id_idx" ON "registrations"("assigned_manager_id");
CREATE INDEX "registrations_next_contact_at_idx" ON "registrations"("next_contact_at");
CREATE INDEX "partner_applications_assigned_manager_id_idx" ON "partner_applications"("assigned_manager_id");
CREATE INDEX "partner_applications_next_contact_at_idx" ON "partner_applications"("next_contact_at");

ALTER TABLE "registrations" ADD CONSTRAINT "registrations_assigned_manager_id_fkey" FOREIGN KEY ("assigned_manager_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "partner_applications" ADD CONSTRAINT "partner_applications_assigned_manager_id_fkey" FOREIGN KEY ("assigned_manager_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
