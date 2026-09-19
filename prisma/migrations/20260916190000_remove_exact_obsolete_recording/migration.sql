-- Permanently remove the obsolete webinar recording that was deleted from
-- production on 2026-09-16. Match both its immutable id and displayed title so
-- this cleanup cannot affect another recording.
DELETE FROM "webinar_recordings"
WHERE "id" = 'cmq8bky18000eo3218badqb83'
  AND "title" = 'Экономика кризиса: как бухгалтеру и юристу развиваться в условиях нестабильности';
