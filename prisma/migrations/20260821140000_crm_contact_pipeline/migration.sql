-- CRM expand batch 1: tenant contacts, pipelines/stages, immutable transition
-- history and server-timestamped contact events. Legacy Lead/Registration and
-- AdminUser remain intact as the compatibility path.

CREATE TYPE "crm_pipeline_status" AS ENUM ('active', 'archived');
CREATE TYPE "crm_stage_status" AS ENUM ('active', 'archived');
CREATE TYPE "crm_stage_semantic_category" AS ENUM ('open', 'won', 'lost');

CREATE UNIQUE INDEX "organization_memberships_id_organization_id_key"
  ON "organization_memberships"("id", "organization_id");

ALTER TABLE "registrations" ADD COLUMN "crm_contact_id" TEXT;

CREATE TABLE "crm_pipelines" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "crm_pipeline_status" NOT NULL DEFAULT 'active',
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_pipelines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_pipelines_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "crm_pipelines_id_organization_id_key"
  ON "crm_pipelines"("id", "organization_id");
CREATE UNIQUE INDEX "crm_pipelines_organization_id_name_key"
  ON "crm_pipelines"("organization_id", "name");
CREATE INDEX "crm_pipelines_organization_id_status_is_default_idx"
  ON "crm_pipelines"("organization_id", "status", "is_default");
CREATE UNIQUE INDEX "crm_pipelines_one_active_default_per_org_key"
  ON "crm_pipelines"("organization_id")
  WHERE "is_default" = true AND "status" = 'active';

CREATE TABLE "crm_stages" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "pipeline_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "semantic_category" "crm_stage_semantic_category" NOT NULL DEFAULT 'open',
  "order_index" INTEGER NOT NULL,
  "status" "crm_stage_status" NOT NULL DEFAULT 'active',
  "is_protected" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_stages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_stages_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_stages_pipeline_id_organization_id_fkey"
    FOREIGN KEY ("pipeline_id", "organization_id")
    REFERENCES "crm_pipelines"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_stages_order_index_check" CHECK ("order_index" >= 0),
  CONSTRAINT "crm_stages_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT "crm_stages_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "crm_stages_pipeline_id_code_key" ON "crm_stages"("pipeline_id", "code");
CREATE UNIQUE INDEX "crm_stages_id_pipeline_id_organization_id_key"
  ON "crm_stages"("id", "pipeline_id", "organization_id");
CREATE UNIQUE INDEX "crm_stages_pipeline_id_order_index_key"
  ON "crm_stages"("pipeline_id", "order_index");
CREATE INDEX "crm_stages_organization_id_status_order_index_idx"
  ON "crm_stages"("organization_id", "status", "order_index");

CREATE TABLE "crm_contacts" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "pipeline_id" TEXT NOT NULL,
  "stage_id" TEXT NOT NULL,
  "legacy_lead_id" TEXT,
  "email_normalized" TEXT,
  "phone_normalized" TEXT,
  "display_name" TEXT,
  "source" TEXT,
  "owner_membership_id" TEXT,
  "legacy_assigned_manager_id" TEXT,
  "next_contact_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_contacts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_contacts_pipeline_id_organization_id_fkey"
    FOREIGN KEY ("pipeline_id", "organization_id")
    REFERENCES "crm_pipelines"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_contacts_stage_id_pipeline_id_organization_id_fkey"
    FOREIGN KEY ("stage_id", "pipeline_id", "organization_id")
    REFERENCES "crm_stages"("id", "pipeline_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_contacts_legacy_lead_id_fkey"
    FOREIGN KEY ("legacy_lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "crm_contacts_owner_membership_id_organization_id_fkey"
    FOREIGN KEY ("owner_membership_id", "organization_id")
    REFERENCES "organization_memberships"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_contacts_legacy_assigned_manager_id_fkey"
    FOREIGN KEY ("legacy_assigned_manager_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "crm_contacts_email_normalized_check"
    CHECK ("email_normalized" IS NULL OR "email_normalized" = lower(btrim("email_normalized"))),
  CONSTRAINT "crm_contacts_phone_normalized_check"
    CHECK ("phone_normalized" IS NULL OR "phone_normalized" ~ '^\+[0-9]{7,18}$')
);

CREATE UNIQUE INDEX "crm_contacts_id_organization_id_key"
  ON "crm_contacts"("id", "organization_id");
CREATE UNIQUE INDEX "crm_contacts_organization_id_email_normalized_key"
  ON "crm_contacts"("organization_id", "email_normalized");
CREATE UNIQUE INDEX "crm_contacts_organization_id_legacy_lead_id_key"
  ON "crm_contacts"("organization_id", "legacy_lead_id");
CREATE INDEX "crm_contacts_organization_id_pipeline_id_stage_id_updated_at_idx"
  ON "crm_contacts"("organization_id", "pipeline_id", "stage_id", "updated_at");
CREATE INDEX "crm_contacts_organization_id_owner_membership_id_next_contact_at_idx"
  ON "crm_contacts"("organization_id", "owner_membership_id", "next_contact_at");
CREATE INDEX "crm_contacts_organization_id_next_contact_at_idx"
  ON "crm_contacts"("organization_id", "next_contact_at");
CREATE INDEX "crm_contacts_legacy_assigned_manager_id_idx"
  ON "crm_contacts"("legacy_assigned_manager_id");

CREATE TABLE "crm_contact_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_entity_type" TEXT,
  "source_entity_id" TEXT,
  "webinar_id" TEXT,
  "webinar_session_id" TEXT,
  "registration_id" TEXT,
  "actor_user_id" TEXT,
  "correlation_id" TEXT,
  "dedup_key" TEXT,
  "metadata_json" JSONB,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_contact_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_contact_events_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_contact_events_contact_id_organization_id_fkey"
    FOREIGN KEY ("contact_id", "organization_id")
    REFERENCES "crm_contacts"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "crm_contact_events_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "crm_contact_events_type_check" CHECK (char_length(btrim("type")) BETWEEN 1 AND 80),
  CONSTRAINT "crm_contact_events_source_check" CHECK (char_length(btrim("source")) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX "crm_contact_events_organization_id_dedup_key_key"
  ON "crm_contact_events"("organization_id", "dedup_key");
CREATE INDEX "crm_contact_events_organization_id_contact_id_occurred_at_idx"
  ON "crm_contact_events"("organization_id", "contact_id", "occurred_at" DESC);
CREATE INDEX "crm_contact_events_organization_id_type_occurred_at_idx"
  ON "crm_contact_events"("organization_id", "type", "occurred_at" DESC);
CREATE INDEX "crm_contact_events_organization_id_webinar_id_webinar_session_id_idx"
  ON "crm_contact_events"("organization_id", "webinar_id", "webinar_session_id");
CREATE INDEX "crm_contact_events_registration_id_idx" ON "crm_contact_events"("registration_id");

CREATE TABLE "crm_stage_transitions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "pipeline_id" TEXT NOT NULL,
  "from_stage_id" TEXT,
  "to_stage_id" TEXT NOT NULL,
  "actor_user_id" TEXT,
  "reason" TEXT,
  "source" TEXT NOT NULL,
  "correlation_id" TEXT,
  "legacy_registration_id" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_stage_transitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_stage_transitions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_stage_transitions_contact_id_organization_id_fkey"
    FOREIGN KEY ("contact_id", "organization_id")
    REFERENCES "crm_contacts"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "crm_stage_transitions_pipeline_id_organization_id_fkey"
    FOREIGN KEY ("pipeline_id", "organization_id")
    REFERENCES "crm_pipelines"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_stage_transitions_from_stage_id_pipeline_id_organization_id_fkey"
    FOREIGN KEY ("from_stage_id", "pipeline_id", "organization_id")
    REFERENCES "crm_stages"("id", "pipeline_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_stage_transitions_to_stage_id_pipeline_id_organization_id_fkey"
    FOREIGN KEY ("to_stage_id", "pipeline_id", "organization_id")
    REFERENCES "crm_stages"("id", "pipeline_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_stage_transitions_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "crm_stage_transitions_legacy_registration_id_fkey"
    FOREIGN KEY ("legacy_registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "crm_stage_transitions_organization_id_legacy_registration_id_key"
  ON "crm_stage_transitions"("organization_id", "legacy_registration_id");
CREATE INDEX "crm_stage_transitions_organization_id_contact_id_occurred_at_idx"
  ON "crm_stage_transitions"("organization_id", "contact_id", "occurred_at" DESC);
CREATE INDEX "crm_stage_transitions_organization_id_to_stage_id_occurred_at_idx"
  ON "crm_stage_transitions"("organization_id", "to_stage_id", "occurred_at" DESC);

INSERT INTO "crm_pipelines" (
  "id", "organization_id", "name", "status", "is_default", "version", "created_at", "updated_at"
)
SELECT
  'crm_pipeline_' || md5(organization."id"),
  organization."id",
  CASE WHEN organization."id" = 'org_aspb' THEN 'Партнёрская воронка АСПБ' ELSE 'Основная воронка' END,
  'active'::"crm_pipeline_status",
  true,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "organizations" organization;

WITH template("code", "name", "semantic_category", "order_index") AS (
  VALUES
    ('new', 'Новый', 'open'::"crm_stage_semantic_category", 10),
    ('qualified', 'Квалифицирован', 'open'::"crm_stage_semantic_category", 20),
    ('contacted', 'Связались', 'open'::"crm_stage_semantic_category", 30),
    ('consultation_scheduled', 'Консультация назначена', 'open'::"crm_stage_semantic_category", 40),
    ('offer_sent', 'Предложение отправлено', 'open'::"crm_stage_semantic_category", 50),
    ('won', 'Успешно', 'won'::"crm_stage_semantic_category", 60),
    ('lost', 'Потерян', 'lost'::"crm_stage_semantic_category", 70),
    ('not_target', 'Не целевой', 'lost'::"crm_stage_semantic_category", 80)
)
INSERT INTO "crm_stages" (
  "id", "organization_id", "pipeline_id", "code", "name", "semantic_category",
  "order_index", "status", "is_protected", "created_at", "updated_at"
)
SELECT
  'crm_stage_' || md5(pipeline."id" || ':' || template."code"),
  pipeline."organization_id",
  pipeline."id",
  template."code",
  template."name",
  template."semantic_category",
  template."order_index",
  'active'::"crm_stage_status",
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "crm_pipelines" pipeline
CROSS JOIN template;

WITH aspb_stage("code", "name", "semantic_category", "order_index") AS (
  VALUES
    ('consultation', 'Консультация', 'open'::"crm_stage_semantic_category", 110),
    ('transferred_to_aspb', 'Передан в АСПБ', 'open'::"crm_stage_semantic_category", 120),
    ('contract_pending', 'Договор на согласовании', 'open'::"crm_stage_semantic_category", 130),
    ('contract_signed', 'Договор подписан', 'open'::"crm_stage_semantic_category", 140),
    ('payout_due', 'Ожидает выплату', 'open'::"crm_stage_semantic_category", 150),
    ('paid', 'Выплачен', 'won'::"crm_stage_semantic_category", 160)
)
INSERT INTO "crm_stages" (
  "id", "organization_id", "pipeline_id", "code", "name", "semantic_category",
  "order_index", "status", "is_protected", "created_at", "updated_at"
)
SELECT
  'crm_stage_' || md5(pipeline."id" || ':' || aspb_stage."code"),
  pipeline."organization_id",
  pipeline."id",
  aspb_stage."code",
  aspb_stage."name",
  aspb_stage."semantic_category",
  aspb_stage."order_index",
  'active'::"crm_stage_status",
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "crm_pipelines" pipeline
CROSS JOIN aspb_stage
WHERE pipeline."organization_id" = 'org_aspb';

WITH observed AS (
  SELECT DISTINCT
    registration."organization_id",
    registration."crm_status" AS code
  FROM "registrations" registration
  WHERE registration."organization_id" IS NOT NULL
), missing AS (
  SELECT
    pipeline."id" AS pipeline_id,
    observed."organization_id",
    observed.code,
    row_number() OVER (PARTITION BY observed."organization_id" ORDER BY observed.code) AS ordinal
  FROM observed
  JOIN "crm_pipelines" pipeline
    ON pipeline."organization_id" = observed."organization_id" AND pipeline."is_default" = true
  LEFT JOIN "crm_stages" stage
    ON stage."pipeline_id" = pipeline."id" AND stage."code" = observed.code
  WHERE stage."id" IS NULL
)
INSERT INTO "crm_stages" (
  "id", "organization_id", "pipeline_id", "code", "name", "semantic_category",
  "order_index", "status", "is_protected", "created_at", "updated_at"
)
SELECT
  'crm_stage_' || md5(missing.pipeline_id || ':' || missing.code),
  missing."organization_id",
  missing.pipeline_id,
  missing.code,
  missing.code,
  CASE WHEN missing.code IN ('paid', 'won') THEN 'won'::"crm_stage_semantic_category"
       WHEN missing.code IN ('lost', 'not_target') THEN 'lost'::"crm_stage_semantic_category"
       ELSE 'open'::"crm_stage_semantic_category" END,
  1000 + missing.ordinal,
  'active'::"crm_stage_status",
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM missing;

WITH contact_scope AS (
  SELECT DISTINCT
    registration."organization_id",
    lead."id" AS lead_id
  FROM "leads" lead
  JOIN "registrations" registration ON registration."lead_id" = lead."id"
  WHERE registration."organization_id" IS NOT NULL
  UNION
  SELECT 'org_aspb', lead."id"
  FROM "leads" lead
  WHERE NOT EXISTS (
    SELECT 1 FROM "registrations" registration WHERE registration."lead_id" = lead."id"
  )
), ranked_registration AS (
  SELECT
    registration.*,
    row_number() OVER (
      PARTITION BY registration."organization_id", registration."lead_id"
      ORDER BY registration."updated_at" DESC, registration."registered_at" DESC, registration."id" DESC
    ) AS rank
  FROM "registrations" registration
  WHERE registration."organization_id" IS NOT NULL
)
INSERT INTO "crm_contacts" (
  "id", "organization_id", "pipeline_id", "stage_id", "legacy_lead_id",
  "email_normalized", "phone_normalized", "display_name", "source",
  "legacy_assigned_manager_id", "next_contact_at", "created_at", "updated_at"
)
SELECT
  'crm_contact_' || md5(scope."organization_id" || ':' || lead."id"),
  scope."organization_id",
  pipeline."id",
  stage."id",
  lead."id",
  lower(btrim(lead."email")),
  CASE
    WHEN regexp_replace(lead."phone", '[^0-9]', '', 'g') = '' THEN NULL
    ELSE '+' || regexp_replace(lead."phone", '[^0-9]', '', 'g')
  END,
  NULLIF(btrim(lead."name"), ''),
  lead."source",
  latest."assigned_manager_id",
  latest."next_contact_at",
  lead."created_at",
  GREATEST(lead."updated_at", COALESCE(latest."updated_at", lead."updated_at"))
FROM contact_scope scope
JOIN "leads" lead ON lead."id" = scope.lead_id
JOIN "crm_pipelines" pipeline
  ON pipeline."organization_id" = scope."organization_id" AND pipeline."is_default" = true
LEFT JOIN ranked_registration latest
  ON latest."organization_id" = scope."organization_id"
 AND latest."lead_id" = scope.lead_id
 AND latest.rank = 1
JOIN "crm_stages" stage
  ON stage."pipeline_id" = pipeline."id" AND stage."code" = COALESCE(latest."crm_status", 'new');

UPDATE "registrations" registration
SET "crm_contact_id" = contact."id"
FROM "crm_contacts" contact
WHERE contact."organization_id" = registration."organization_id"
  AND contact."legacy_lead_id" = registration."lead_id";

INSERT INTO "crm_contact_events" (
  "id", "organization_id", "contact_id", "type", "source", "source_entity_type",
  "source_entity_id", "webinar_id", "webinar_session_id", "registration_id",
  "dedup_key", "metadata_json", "occurred_at", "created_at"
)
SELECT
  'crm_event_' || md5(registration."organization_id" || ':registration:' || registration."id"),
  registration."organization_id",
  registration."crm_contact_id",
  'registration',
  'legacy_backfill',
  'registration',
  registration."id",
  registration."webinar_id",
  registration."webinar_session_id",
  registration."id",
  'legacy-registration:' || registration."id",
  jsonb_build_object('registrationStatus', registration."status", 'crmStageCode', registration."crm_status"),
  registration."registered_at",
  CURRENT_TIMESTAMP
FROM "registrations" registration
WHERE registration."organization_id" IS NOT NULL
  AND registration."crm_contact_id" IS NOT NULL;

INSERT INTO "crm_stage_transitions" (
  "id", "organization_id", "contact_id", "pipeline_id", "from_stage_id", "to_stage_id",
  "reason", "source", "legacy_registration_id", "occurred_at", "created_at"
)
SELECT
  'crm_transition_' || md5(registration."organization_id" || ':' || registration."id"),
  registration."organization_id",
  registration."crm_contact_id",
  contact."pipeline_id",
  NULL,
  stage."id",
  CASE WHEN stage."semantic_category" = 'lost'
    THEN 'Причина не была сохранена в legacy-системе'
    ELSE NULL END,
  'legacy_backfill',
  registration."id",
  registration."updated_at",
  CURRENT_TIMESTAMP
FROM "registrations" registration
JOIN "crm_contacts" contact
  ON contact."id" = registration."crm_contact_id"
 AND contact."organization_id" = registration."organization_id"
JOIN "crm_stages" stage
  ON stage."pipeline_id" = contact."pipeline_id"
 AND stage."organization_id" = contact."organization_id"
 AND stage."code" = registration."crm_status"
WHERE registration."organization_id" IS NOT NULL;

ALTER TABLE "registrations"
  ADD CONSTRAINT "registrations_crm_contact_id_organization_id_fkey"
  FOREIGN KEY ("crm_contact_id", "organization_id")
  REFERENCES "crm_contacts"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "registrations_organization_id_crm_contact_id_idx"
  ON "registrations"("organization_id", "crm_contact_id");

CREATE FUNCTION crm_require_lost_transition_reason() RETURNS trigger AS $$
DECLARE
  target_category "crm_stage_semantic_category";
BEGIN
  SELECT "semantic_category" INTO target_category
  FROM "crm_stages"
  WHERE "id" = NEW."to_stage_id"
    AND "pipeline_id" = NEW."pipeline_id"
    AND "organization_id" = NEW."organization_id";

  IF target_category = 'lost' AND NULLIF(btrim(NEW."reason"), '') IS NULL THEN
    RAISE EXCEPTION 'lost CRM transition requires a reason' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "crm_stage_transitions_require_lost_reason"
BEFORE INSERT OR UPDATE OF "to_stage_id", "reason" ON "crm_stage_transitions"
FOR EACH ROW EXECUTE FUNCTION crm_require_lost_transition_reason();

CREATE FUNCTION crm_protect_stage_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'CRM stage code is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."is_protected" THEN
      RAISE EXCEPTION 'protected CRM stage cannot be deleted' USING ERRCODE = '23503';
    END IF;
    IF EXISTS (SELECT 1 FROM "crm_contacts" WHERE "stage_id" = OLD."id")
      OR EXISTS (
        SELECT 1 FROM "crm_stage_transitions"
        WHERE "from_stage_id" = OLD."id" OR "to_stage_id" = OLD."id"
      ) THEN
      RAISE EXCEPTION 'used CRM stage cannot be deleted' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "crm_stages_protect_identity_update"
BEFORE UPDATE OF "code" ON "crm_stages"
FOR EACH ROW EXECUTE FUNCTION crm_protect_stage_identity();

CREATE TRIGGER "crm_stages_protect_delete"
BEFORE DELETE ON "crm_stages"
FOR EACH ROW EXECUTE FUNCTION crm_protect_stage_identity();
