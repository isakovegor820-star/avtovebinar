CREATE TYPE "crm_scoring_rule_set_status" AS ENUM ('draft', 'active', 'archived');
CREATE TYPE "crm_tag_status" AS ENUM ('active', 'archived');

ALTER TABLE "crm_contacts"
  ADD COLUMN "score" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "score_rule_set_id" TEXT,
  ADD COLUMN "score_computed_at" TIMESTAMP(3),
  ADD COLUMN "manual_hot" BOOLEAN,
  ADD COLUMN "manual_hot_reason" TEXT,
  ADD COLUMN "manual_hot_by_membership_id" TEXT,
  ADD COLUMN "manual_hot_at" TIMESTAMP(3),
  ADD COLUMN "manual_hot_source" TEXT,
  ADD CONSTRAINT "crm_contacts_score_nonnegative_check" CHECK ("score" >= 0),
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
        ("manual_hot_source" = 'tenant_crm' AND "manual_hot_by_membership_id" IS NOT NULL)
        OR ("manual_hot_source" = 'legacy_backfill' AND "manual_hot_by_membership_id" IS NULL)
      )
    )
  );

CREATE TABLE "crm_scoring_rule_sets" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "status" "crm_scoring_rule_set_status" NOT NULL DEFAULT 'draft',
  "hot_threshold" INTEGER NOT NULL,
  "idempotency_key" TEXT,
  "created_by_membership_id" TEXT,
  "activated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "crm_scoring_rule_sets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_scoring_rule_sets_version_check" CHECK ("version" >= 1),
  CONSTRAINT "crm_scoring_rule_sets_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "crm_scoring_rule_sets_threshold_check" CHECK ("hot_threshold" BETWEEN 0 AND 10000),
  CONSTRAINT "crm_scoring_rule_sets_activation_check" CHECK (
    ("status" = 'draft' AND "activated_at" IS NULL)
    OR ("status" IN ('active', 'archived') AND "activated_at" IS NOT NULL)
  )
);

CREATE TABLE "crm_scoring_rules" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "rule_set_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "crm_scoring_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_scoring_rules_code_check" CHECK (
    "code" IN ('registration', 'room_entered', 'viewed_50_percent', 'question', 'cta')
  ),
  CONSTRAINT "crm_scoring_rules_label_check" CHECK (char_length(btrim("label")) BETWEEN 1 AND 120),
  CONSTRAINT "crm_scoring_rules_points_check" CHECK ("points" BETWEEN 0 AND 100)
);

CREATE TABLE "crm_score_factors" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "signal_code" TEXT NOT NULL,
  "source_entity_type" TEXT NOT NULL,
  "source_entity_id" TEXT NOT NULL,
  "dedup_key" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "crm_score_factors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_score_factors_signal_check" CHECK (
    "signal_code" IN ('registration', 'room_entered', 'viewed_50_percent', 'question', 'cta')
  ),
  CONSTRAINT "crm_score_factors_source_check" CHECK (
    char_length(btrim("source_entity_type")) BETWEEN 1 AND 80
    AND char_length(btrim("source_entity_id")) BETWEEN 1 AND 191
    AND char_length(btrim("dedup_key")) BETWEEN 8 AND 300
  )
);

CREATE TABLE "crm_tags" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "normalized_name" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color_token" TEXT NOT NULL DEFAULT 'slate',
  "status" "crm_tag_status" NOT NULL DEFAULT 'active',
  "created_by_membership_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "crm_tags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_tags_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "crm_tags_normalized_name_check" CHECK (
    "normalized_name" = lower(regexp_replace(btrim("name"), '\s+', ' ', 'g'))
  ),
  CONSTRAINT "crm_tags_color_token_check" CHECK (
    "color_token" IN ('slate', 'blue', 'teal', 'amber', 'red', 'violet')
  )
);

CREATE TABLE "crm_contact_tags" (
  "organization_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "tag_id" TEXT NOT NULL,
  "assigned_by_membership_id" TEXT NOT NULL,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "crm_contact_tags_pkey" PRIMARY KEY ("contact_id", "tag_id")
);

CREATE UNIQUE INDEX "crm_scoring_rule_sets_id_organization_id_key"
  ON "crm_scoring_rule_sets"("id", "organization_id");
CREATE UNIQUE INDEX "crm_scoring_rule_sets_organization_id_version_key"
  ON "crm_scoring_rule_sets"("organization_id", "version");
CREATE UNIQUE INDEX "crm_scoring_rule_sets_organization_id_idempotency_key"
  ON "crm_scoring_rule_sets"("organization_id", "idempotency_key");
CREATE UNIQUE INDEX "crm_scoring_rule_sets_one_active_per_organization"
  ON "crm_scoring_rule_sets"("organization_id") WHERE "status" = 'active';
CREATE INDEX "crm_scoring_rule_sets_organization_id_status_version_idx"
  ON "crm_scoring_rule_sets"("organization_id", "status", "version");
CREATE UNIQUE INDEX "crm_scoring_rules_rule_set_id_code_key"
  ON "crm_scoring_rules"("rule_set_id", "code");
CREATE INDEX "crm_scoring_rules_organization_id_code_idx"
  ON "crm_scoring_rules"("organization_id", "code");
CREATE UNIQUE INDEX "crm_score_factors_organization_id_dedup_key"
  ON "crm_score_factors"("organization_id", "dedup_key");
CREATE INDEX "crm_score_factors_organization_contact_signal_occurred_idx"
  ON "crm_score_factors"("organization_id", "contact_id", "signal_code", "occurred_at");
CREATE UNIQUE INDEX "crm_tags_id_organization_id_key"
  ON "crm_tags"("id", "organization_id");
CREATE UNIQUE INDEX "crm_tags_organization_id_normalized_name_key"
  ON "crm_tags"("organization_id", "normalized_name");
CREATE INDEX "crm_tags_organization_id_status_name_idx"
  ON "crm_tags"("organization_id", "status", "name");
CREATE INDEX "crm_contact_tags_organization_id_tag_assigned_idx"
  ON "crm_contact_tags"("organization_id", "tag_id", "assigned_at");
CREATE INDEX "crm_contacts_organization_id_score_updated_at_idx"
  ON "crm_contacts"("organization_id", "score", "updated_at");
CREATE INDEX "crm_contacts_organization_id_manual_hot_updated_at_idx"
  ON "crm_contacts"("organization_id", "manual_hot", "updated_at");

ALTER TABLE "crm_scoring_rule_sets"
  ADD CONSTRAINT "crm_scoring_rule_sets_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_scoring_rule_sets_creator_scope_fkey"
    FOREIGN KEY ("created_by_membership_id", "organization_id")
    REFERENCES "organization_memberships"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "crm_scoring_rules"
  ADD CONSTRAINT "crm_scoring_rules_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_scoring_rules_rule_set_scope_fkey"
    FOREIGN KEY ("rule_set_id", "organization_id")
    REFERENCES "crm_scoring_rule_sets"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "crm_score_factors"
  ADD CONSTRAINT "crm_score_factors_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_score_factors_contact_scope_fkey"
    FOREIGN KEY ("contact_id", "organization_id")
    REFERENCES "crm_contacts"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_tags"
  ADD CONSTRAINT "crm_tags_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_tags_creator_scope_fkey"
    FOREIGN KEY ("created_by_membership_id", "organization_id")
    REFERENCES "organization_memberships"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "crm_contact_tags"
  ADD CONSTRAINT "crm_contact_tags_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_contact_tags_contact_scope_fkey"
    FOREIGN KEY ("contact_id", "organization_id")
    REFERENCES "crm_contacts"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_contact_tags_tag_scope_fkey"
    FOREIGN KEY ("tag_id", "organization_id")
    REFERENCES "crm_tags"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_contact_tags_assigner_scope_fkey"
    FOREIGN KEY ("assigned_by_membership_id", "organization_id")
    REFERENCES "organization_memberships"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "crm_contacts"
  ADD CONSTRAINT "crm_contacts_score_rule_set_scope_fkey"
    FOREIGN KEY ("score_rule_set_id", "organization_id")
    REFERENCES "crm_scoring_rule_sets"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_contacts_manual_hot_membership_scope_fkey"
    FOREIGN KEY ("manual_hot_by_membership_id", "organization_id")
    REFERENCES "organization_memberships"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "aspb_refresh_crm_contact_score"(
  target_organization_id TEXT,
  target_contact_id TEXT
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  active_rule_set_id TEXT;
  active_hot_threshold INTEGER;
  calculated_score INTEGER;
  effective_hot BOOLEAN;
BEGIN
  SELECT ruleset."id", ruleset."hot_threshold"
  INTO active_rule_set_id, active_hot_threshold
  FROM "crm_scoring_rule_sets" ruleset
  WHERE ruleset."organization_id" = target_organization_id
    AND ruleset."status" = 'active'
  ORDER BY ruleset."version" DESC
  LIMIT 1;

  IF active_rule_set_id IS NULL THEN
    calculated_score := 0;
  ELSE
    SELECT COALESCE(SUM(rule."points"), 0)::INTEGER
    INTO calculated_score
    FROM "crm_score_factors" factor
    JOIN "crm_scoring_rules" rule
      ON rule."rule_set_id" = active_rule_set_id
     AND rule."organization_id" = factor."organization_id"
     AND rule."code" = factor."signal_code"
    WHERE factor."organization_id" = target_organization_id
      AND factor."contact_id" = target_contact_id;
  END IF;

  UPDATE "crm_contacts" contact
  SET "score" = calculated_score,
      "score_rule_set_id" = active_rule_set_id,
      "score_computed_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE contact."organization_id" = target_organization_id
    AND contact."id" = target_contact_id
  RETURNING COALESCE(
    contact."manual_hot",
    active_rule_set_id IS NOT NULL AND calculated_score >= active_hot_threshold
  ) INTO effective_hot;

  IF FOUND THEN
    UPDATE "registrations" registration
    SET "is_hot" = effective_hot,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE registration."organization_id" = target_organization_id
      AND registration."crm_contact_id" = target_contact_id
      AND registration."is_hot" IS DISTINCT FROM effective_hot;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "aspb_validate_crm_scoring_rule_set"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_rule_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."created_by_membership_id" IS DISTINCT FROM OLD."created_by_membership_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
  ) THEN
    RAISE EXCEPTION 'CRM scoring rule-set identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_scoring_rule_set_identity_immutable';
  END IF;

  IF NEW."status" = 'active' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status") THEN
    SELECT COUNT(*) INTO required_rule_count
    FROM "crm_scoring_rules" rule
    WHERE rule."organization_id" = NEW."organization_id"
      AND rule."rule_set_id" = NEW."id"
      AND rule."code" IN ('registration', 'room_entered', 'viewed_50_percent', 'question', 'cta');
    IF required_rule_count <> 5 THEN
      RAISE EXCEPTION 'CRM scoring rule-set is incomplete'
        USING ERRCODE = '23514', CONSTRAINT = 'crm_scoring_rule_set_required_rules';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_scoring_rule_sets_validate_trigger"
BEFORE INSERT OR UPDATE ON "crm_scoring_rule_sets"
FOR EACH ROW EXECUTE FUNCTION "aspb_validate_crm_scoring_rule_set"();

CREATE OR REPLACE FUNCTION "aspb_refresh_crm_scores_after_rule_set_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
    RETURN NEW;
  END IF;
  PERFORM "aspb_refresh_crm_contact_score"(contact."organization_id", contact."id")
  FROM "crm_contacts" contact
  WHERE contact."organization_id" = NEW."organization_id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_scoring_rule_sets_refresh_scores_trigger"
AFTER INSERT OR UPDATE OF "status" ON "crm_scoring_rule_sets"
FOR EACH ROW EXECUTE FUNCTION "aspb_refresh_crm_scores_after_rule_set_change"();

CREATE OR REPLACE FUNCTION "aspb_validate_crm_scoring_rule"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status "crm_scoring_rule_set_status";
BEGIN
  SELECT ruleset."status" INTO parent_status
  FROM "crm_scoring_rule_sets" ruleset
  WHERE ruleset."id" = COALESCE(NEW."rule_set_id", OLD."rule_set_id")
    AND ruleset."organization_id" = COALESCE(NEW."organization_id", OLD."organization_id");
  IF parent_status IS DISTINCT FROM 'draft'::"crm_scoring_rule_set_status" THEN
    RAISE EXCEPTION 'Only draft CRM scoring rules may change'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_scoring_rules_active_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_scoring_rules_validate_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "crm_scoring_rules"
FOR EACH ROW EXECUTE FUNCTION "aspb_validate_crm_scoring_rule"();

CREATE OR REPLACE FUNCTION "aspb_refresh_crm_score_after_factor"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "aspb_refresh_crm_contact_score"(NEW."organization_id", NEW."contact_id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_score_factors_refresh_score_trigger"
AFTER INSERT ON "crm_score_factors"
FOR EACH ROW EXECUTE FUNCTION "aspb_refresh_crm_score_after_factor"();

CREATE OR REPLACE FUNCTION "aspb_prevent_crm_score_factor_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CRM score factors are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'crm_score_factors_immutable';
END;
$$;

CREATE TRIGGER "crm_score_factors_prevent_mutation_trigger"
BEFORE UPDATE OR DELETE ON "crm_score_factors"
FOR EACH ROW EXECUTE FUNCTION "aspb_prevent_crm_score_factor_mutation"();

CREATE OR REPLACE FUNCTION "aspb_validate_crm_manual_hot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."manual_hot" IS NOT NULL AND NEW."manual_hot_source" = 'tenant_crm' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "organization_memberships" membership
      WHERE membership."id" = NEW."manual_hot_by_membership_id"
        AND membership."organization_id" = NEW."organization_id"
        AND membership."status" = 'active'
        AND membership."role" IN ('owner', 'crm_manager')
    ) THEN
      RAISE EXCEPTION 'CRM manual hot actor is unavailable'
        USING ERRCODE = '23514', CONSTRAINT = 'crm_contacts_manual_hot_actor_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_contacts_validate_manual_hot_trigger"
BEFORE INSERT OR UPDATE OF "manual_hot", "manual_hot_by_membership_id", "manual_hot_source" ON "crm_contacts"
FOR EACH ROW EXECUTE FUNCTION "aspb_validate_crm_manual_hot"();

CREATE OR REPLACE FUNCTION "aspb_refresh_crm_score_after_manual_hot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "aspb_refresh_crm_contact_score"(NEW."organization_id", NEW."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_contacts_refresh_score_after_manual_hot_trigger"
AFTER UPDATE OF "manual_hot", "manual_hot_reason", "manual_hot_by_membership_id", "manual_hot_at", "manual_hot_source"
ON "crm_contacts"
FOR EACH ROW EXECUTE FUNCTION "aspb_refresh_crm_score_after_manual_hot"();

CREATE OR REPLACE FUNCTION "aspb_validate_crm_tag_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."created_by_membership_id" IS DISTINCT FROM OLD."created_by_membership_id"
  ) THEN
    RAISE EXCEPTION 'CRM tag identity scope is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_tags_identity_scope_immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "organization_memberships" membership
      WHERE membership."id" = NEW."created_by_membership_id"
        AND membership."organization_id" = NEW."organization_id"
        AND membership."status" = 'active'
        AND membership."role" IN ('owner', 'crm_manager')
    ) THEN
      RAISE EXCEPTION 'CRM tag creator is unavailable'
        USING ERRCODE = '23514', CONSTRAINT = 'crm_tags_active_creator_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_tags_validate_scope_trigger"
BEFORE INSERT OR UPDATE ON "crm_tags"
FOR EACH ROW EXECUTE FUNCTION "aspb_validate_crm_tag_scope"();

CREATE OR REPLACE FUNCTION "aspb_validate_crm_contact_tag_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'CRM contact tag identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_contact_tags_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "organization_memberships" membership
    WHERE membership."id" = NEW."assigned_by_membership_id"
      AND membership."organization_id" = NEW."organization_id"
      AND membership."status" = 'active'
      AND membership."role" IN ('owner', 'crm_manager')
  ) THEN
    RAISE EXCEPTION 'CRM tag assigner is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_contact_tags_active_assigner_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crm_contact_tags_validate_scope_trigger"
BEFORE INSERT OR UPDATE ON "crm_contact_tags"
FOR EACH ROW EXECUTE FUNCTION "aspb_validate_crm_contact_tag_scope"();

CREATE OR REPLACE FUNCTION "aspb_prevent_used_crm_tag_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "crm_contact_tags" assignment WHERE assignment."tag_id" = OLD."id") THEN
    RAISE EXCEPTION 'Used CRM tags must be archived or reassigned'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_tags_used_delete_forbidden';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "crm_tags_prevent_used_delete_trigger"
BEFORE DELETE ON "crm_tags"
FOR EACH ROW EXECUTE FUNCTION "aspb_prevent_used_crm_tag_delete"();

UPDATE "crm_contacts" contact
SET "manual_hot" = TRUE,
    "manual_hot_reason" = 'Перенесено из legacy CRM',
    "manual_hot_at" = COALESCE((
      SELECT MAX(registration."updated_at")
      FROM "registrations" registration
      WHERE registration."organization_id" = contact."organization_id"
        AND registration."crm_contact_id" = contact."id"
        AND registration."is_hot" = TRUE
    ), CURRENT_TIMESTAMP),
    "manual_hot_source" = 'legacy_backfill'
WHERE EXISTS (
  SELECT 1
  FROM "registrations" registration
  WHERE registration."organization_id" = contact."organization_id"
    AND registration."crm_contact_id" = contact."id"
    AND registration."is_hot" = TRUE
);

INSERT INTO "crm_scoring_rule_sets" (
  "id", "organization_id", "version", "name", "status", "hot_threshold",
  "activated_at", "created_at", "updated_at"
)
SELECT
  'score_rs_' || md5(pipeline."organization_id"),
  pipeline."organization_id",
  1,
  'Базовая модель',
  'draft',
  60,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "crm_pipelines" pipeline
WHERE pipeline."is_default" = TRUE
  AND pipeline."status" = 'active'
ON CONFLICT ("organization_id", "version") DO NOTHING;

INSERT INTO "crm_scoring_rules" (
  "id", "organization_id", "rule_set_id", "code", "label", "points", "created_at"
)
SELECT
  'score_rule_' || md5(ruleset."id" || ':' || seed."code"),
  ruleset."organization_id",
  ruleset."id",
  seed."code",
  seed."label",
  seed."points",
  CURRENT_TIMESTAMP
FROM "crm_scoring_rule_sets" ruleset
CROSS JOIN (VALUES
  ('registration', 'Регистрация', 10),
  ('room_entered', 'Вход в комнату', 15),
  ('viewed_50_percent', 'Просмотрено не менее 50%', 25),
  ('question', 'Задан вопрос', 25),
  ('cta', 'Нажата CTA и отправлена заявка', 35)
) AS seed("code", "label", "points")
WHERE ruleset."version" = 1
ON CONFLICT ("rule_set_id", "code") DO NOTHING;

UPDATE "crm_scoring_rule_sets"
SET "status" = 'active',
    "activated_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "version" = 1
  AND "status" = 'draft';

INSERT INTO "crm_score_factors" (
  "id", "organization_id", "contact_id", "signal_code",
  "source_entity_type", "source_entity_id", "dedup_key", "occurred_at", "created_at"
)
SELECT
  'score_factor_' || md5(registration."organization_id" || ':registration:' || registration."id"),
  registration."organization_id",
  registration."crm_contact_id",
  'registration',
  'registration',
  registration."id",
  'score:registration:registration:' || registration."id",
  registration."registered_at",
  CURRENT_TIMESTAMP
FROM "registrations" registration
WHERE registration."organization_id" IS NOT NULL
  AND registration."crm_contact_id" IS NOT NULL
  AND registration."status" = 'registered'
ON CONFLICT ("organization_id", "dedup_key") DO NOTHING;

INSERT INTO "crm_score_factors" (
  "id", "organization_id", "contact_id", "signal_code",
  "source_entity_type", "source_entity_id", "dedup_key", "occurred_at", "created_at"
)
SELECT
  'score_factor_' || md5(registration."organization_id" || ':room:' || registration."id"),
  registration."organization_id",
  registration."crm_contact_id",
  'room_entered',
  'registration',
  registration."id",
  'score:room_entered:registration:' || registration."id",
  registration."room_entered_at",
  CURRENT_TIMESTAMP
FROM "registrations" registration
WHERE registration."organization_id" IS NOT NULL
  AND registration."crm_contact_id" IS NOT NULL
  AND registration."room_entered_at" IS NOT NULL
ON CONFLICT ("organization_id", "dedup_key") DO NOTHING;

INSERT INTO "crm_score_factors" (
  "id", "organization_id", "contact_id", "signal_code",
  "source_entity_type", "source_entity_id", "dedup_key", "occurred_at", "created_at"
)
SELECT DISTINCT ON (progress."organization_id", progress."id")
  'score_factor_' || md5(progress."organization_id" || ':progress50:' || progress."id"),
  progress."organization_id",
  registration."crm_contact_id",
  'viewed_50_percent',
  'viewer_progress',
  progress."id",
  'score:viewed_50_percent:viewer_progress:' || progress."id",
  progress."last_observed_at",
  CURRENT_TIMESTAMP
FROM "viewer_webinar_progress" progress
JOIN "registrations" registration
  ON registration."organization_id" = progress."organization_id"
 AND registration."user_id" = progress."user_id"
 AND registration."webinar_session_id" = progress."webinar_session_id"
WHERE registration."crm_contact_id" IS NOT NULL
  AND progress."duration_ms" > 0
  AND progress."position_ms" * 2 >= progress."duration_ms"
ORDER BY progress."organization_id", progress."id", registration."registered_at" ASC
ON CONFLICT ("organization_id", "dedup_key") DO NOTHING;

INSERT INTO "crm_score_factors" (
  "id", "organization_id", "contact_id", "signal_code",
  "source_entity_type", "source_entity_id", "dedup_key", "occurred_at", "created_at"
)
SELECT
  'score_factor_' || md5(registration."organization_id" || ':question:' || question."id"),
  registration."organization_id",
  registration."crm_contact_id",
  'question',
  'question',
  question."id",
  'score:question:question:' || question."id",
  question."created_at",
  CURRENT_TIMESTAMP
FROM "questions" question
JOIN "registrations" registration ON registration."id" = question."registration_id"
WHERE registration."organization_id" IS NOT NULL
  AND registration."crm_contact_id" IS NOT NULL
ON CONFLICT ("organization_id", "dedup_key") DO NOTHING;

INSERT INTO "crm_score_factors" (
  "id", "organization_id", "contact_id", "signal_code",
  "source_entity_type", "source_entity_id", "dedup_key", "occurred_at", "created_at"
)
SELECT
  'score_factor_' || md5(registration."organization_id" || ':cta:' || application."id"),
  registration."organization_id",
  registration."crm_contact_id",
  'cta',
  'partner_application',
  application."id",
  'score:cta:partner_application:' || application."id",
  application."created_at",
  CURRENT_TIMESTAMP
FROM "partner_applications" application
JOIN "registrations" registration ON registration."id" = application."registration_id"
WHERE registration."organization_id" IS NOT NULL
  AND registration."crm_contact_id" IS NOT NULL
ON CONFLICT ("organization_id", "dedup_key") DO NOTHING;
