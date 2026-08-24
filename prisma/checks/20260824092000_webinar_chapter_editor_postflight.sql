DO $$
DECLARE invalid_rows bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'webinar_chapters' AND column_name = 'revision'
  ) THEN
    RAISE EXCEPTION 'webinar_chapters.revision is missing';
  END IF;
  SELECT count(*) INTO invalid_rows
  FROM webinar_chapters
  WHERE revision < 1 OR origin NOT IN ('MANUAL', 'AI_REVIEWED', 'LEGACY_UNKNOWN') OR start_ms < 0 OR order_index < 0;
  IF invalid_rows <> 0 THEN
    RAISE EXCEPTION 'invalid webinar chapter rows after migration: %', invalid_rows;
  END IF;
END $$;
