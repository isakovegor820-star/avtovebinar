DO $$
BEGIN
  IF to_regclass('public.webinars') IS NULL OR to_regclass('public.author_profiles') IS NULL THEN
    RAISE EXCEPTION 'freshness review prerequisites are missing';
  END IF;
END $$;
