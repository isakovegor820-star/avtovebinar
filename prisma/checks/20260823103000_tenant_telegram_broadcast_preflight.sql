-- Read-only inventory before BOT-008/BOT-009/BOT-011/BOT-012 expand.
SELECT status, COUNT(*) AS jobs
FROM telegram_broadcast_jobs
GROUP BY status
ORDER BY status;

SELECT COUNT(*) AS incomplete_legacy_broadcast_snapshots
FROM telegram_broadcast_jobs job
WHERE job.total <> (SELECT COUNT(*) FROM telegram_broadcast_recipients recipient WHERE recipient.job_id = job.id);

SELECT COUNT(*) AS existing_tenant_broadcast_tables
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name IN ('telegram_broadcast_templates', 'telegram_broadcast_previews');
