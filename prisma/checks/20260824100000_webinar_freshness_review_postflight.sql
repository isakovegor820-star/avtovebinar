DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='webinars' AND column_name='review_due_at'
  ) THEN RAISE EXCEPTION 'webinars.review_due_at is missing'; END IF;
  IF to_regclass('public.author_review_tasks') IS NULL OR to_regclass('public.author_service_notifications') IS NULL THEN
    RAISE EXCEPTION 'freshness task/outbox tables are missing';
  END IF;
END $$;
