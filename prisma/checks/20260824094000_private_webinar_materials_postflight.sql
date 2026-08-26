DO $$
DECLARE invalid_rows bigint;
BEGIN
  IF to_regclass('public.webinar_materials') IS NULL OR to_regclass('public.webinar_material_uploads') IS NULL THEN
    RAISE EXCEPTION 'private material tables are missing';
  END IF;
  SELECT count(*) INTO invalid_rows FROM webinar_materials
  WHERE size_bytes <= 0 OR revision < 1 OR storage_key NOT LIKE 'organizations/%/webinars/%/materials/%/source';
  IF invalid_rows <> 0 THEN
    RAISE EXCEPTION 'invalid private material rows after migration: %', invalid_rows;
  END IF;
END $$;
