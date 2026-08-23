-- BOT-005: retain the existing explainable manual-hot invariant while allowing
-- the same active tenant membership to act through the platform manager bot.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "crm_contacts"
  DROP CONSTRAINT "crm_contacts_manual_hot_state_check",
  ADD CONSTRAINT "crm_contacts_manual_hot_state_check" CHECK (
    (
      "manual_hot" IS NULL
      AND "manual_hot_reason" IS NULL
      AND "manual_hot_by_membership_id" IS NULL
      AND "manual_hot_at" IS NULL
      AND "manual_hot_source" IS NULL
    )
    OR (
      "manual_hot" IS NOT NULL
      AND char_length(btrim("manual_hot_reason")) BETWEEN 3 AND 500
      AND "manual_hot_at" IS NOT NULL
      AND (
        ("manual_hot_source" IN ('tenant_crm', 'telegram_manager_bot') AND "manual_hot_by_membership_id" IS NOT NULL)
        OR ("manual_hot_source" = 'legacy_backfill' AND "manual_hot_by_membership_id" IS NULL)
      )
    )
  );

RESET statement_timeout;
RESET lock_timeout;
