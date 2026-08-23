-- Additive integrity hardening for the first CRM batch. This does not remove
-- or rewrite legacy data; it closes direct-SQL paths around the same
-- invariants already enforced by the tenant CRM service.

CREATE OR REPLACE FUNCTION crm_protect_stage_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."organization_id" <> OLD."organization_id"
      OR NEW."pipeline_id" <> OLD."pipeline_id" THEN
      RAISE EXCEPTION 'CRM stage tenant and pipeline are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."code" <> OLD."code" THEN
      RAISE EXCEPTION 'CRM stage code is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."semantic_category" <> OLD."semantic_category" THEN
      RAISE EXCEPTION 'CRM stage semantic category is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."is_protected" AND NOT NEW."is_protected" THEN
      RAISE EXCEPTION 'protected CRM stage cannot be unprotected' USING ERRCODE = '23514';
    END IF;
    IF OLD."is_protected" AND NEW."status" = 'archived' THEN
      RAISE EXCEPTION 'protected CRM stage cannot be archived' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

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
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "crm_stages_protect_identity_update" ON "crm_stages";
CREATE TRIGGER "crm_stages_protect_identity_update"
BEFORE UPDATE OF "organization_id", "pipeline_id", "code", "semantic_category", "is_protected", "status"
ON "crm_stages"
FOR EACH ROW EXECUTE FUNCTION crm_protect_stage_identity();

CREATE FUNCTION crm_validate_registration_contact_scope() RETURNS trigger AS $$
BEGIN
  IF NEW."crm_contact_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "crm_contacts" contact
    WHERE contact."id" = NEW."crm_contact_id"
      AND contact."organization_id" = NEW."organization_id"
      AND contact."legacy_lead_id" = NEW."lead_id"
  ) THEN
    RAISE EXCEPTION 'registration CRM contact scope mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "registrations_validate_crm_contact_scope"
BEFORE INSERT OR UPDATE OF "crm_contact_id", "organization_id", "lead_id"
ON "registrations"
FOR EACH ROW EXECUTE FUNCTION crm_validate_registration_contact_scope();
