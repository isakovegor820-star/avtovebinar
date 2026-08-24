DO $$
BEGIN
  IF to_regclass('public.webinar_chapters') IS NULL THEN
    RAISE EXCEPTION 'webinar_chapters table is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM webinar_chapters WHERE start_ms < 0 OR order_index < 0) THEN
    RAISE EXCEPTION 'legacy webinar chapters contain negative start/order values';
  END IF;
END $$;
