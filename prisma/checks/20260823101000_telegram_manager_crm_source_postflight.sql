-- Must be zero after the BOT-005 CRM source allowlist migration.
SELECT COUNT(*) AS telegram_manager_manual_hot_scope_violations
FROM crm_contacts contact
LEFT JOIN organization_memberships membership
  ON membership.id = contact.manual_hot_by_membership_id
 AND membership.organization_id = contact.organization_id
WHERE contact.manual_hot_source = 'telegram_manager_bot'
  AND (
    contact.manual_hot IS NULL
    OR contact.manual_hot_reason IS NULL
    OR char_length(btrim(contact.manual_hot_reason)) NOT BETWEEN 3 AND 500
    OR contact.manual_hot_at IS NULL
    OR membership.id IS NULL
  );
