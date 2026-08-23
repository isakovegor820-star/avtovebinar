-- Read-only source inventory before extending the CRM manual-hot source allowlist.
SELECT manual_hot_source, COUNT(*) AS contact_count
FROM crm_contacts
WHERE manual_hot IS NOT NULL
GROUP BY manual_hot_source
ORDER BY manual_hot_source;

SELECT COUNT(*) AS existing_manual_hot_state_violations
FROM crm_contacts
WHERE manual_hot IS NOT NULL
  AND (
    manual_hot_reason IS NULL
    OR char_length(btrim(manual_hot_reason)) NOT BETWEEN 3 AND 500
    OR manual_hot_at IS NULL
  );
