-- Remove the obsolete 9:28 preview that was published before the full webinar
-- replaced the original short media. Keep the predicate deliberately narrow so
-- no other recordings can be affected by this cleanup.
DELETE FROM "webinar_recordings"
WHERE "duration_seconds" = 568
  AND "category" = 'webinar'
  AND "title" = 'Экономика кризиса: как юристу зарабатывать на защите финансовых прав бизнеса';
