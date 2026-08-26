-- pg_dump restores functions before table data while using an empty session
-- search_path. The recursive privacy validator must carry the schema in which
-- Prisma created it, otherwise COPY events cannot resolve its self-call.
ALTER FUNCTION analytics_metadata_is_safe(JSONB, INTEGER)
  SET search_path FROM CURRENT;
