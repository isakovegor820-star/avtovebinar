DO $$
BEGIN
  IF to_regclass('public.webinars') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'webinars/users prerequisites are missing';
  END IF;
  IF to_regclass('public.webinar_materials') IS NOT NULL OR to_regclass('public.webinar_material_uploads') IS NOT NULL THEN
    RAISE EXCEPTION 'private material tables already exist outside this migration';
  END IF;
END $$;
