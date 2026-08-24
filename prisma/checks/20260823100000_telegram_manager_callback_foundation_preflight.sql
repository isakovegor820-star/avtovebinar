-- Read-only inventory before BOT manager binding/callback expand.
SELECT COUNT(*) AS legacy_admin_callback_rows
FROM registrations
WHERE telegram_clicked_at IS NOT NULL;

SELECT COUNT(*) AS tenant_crm_registrations_without_exact_scope
FROM registrations registration
WHERE registration.crm_contact_id IS NOT NULL
  AND (
    registration.organization_id IS NULL
    OR registration.webinar_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM webinar_sessions session
      WHERE session.id = registration.webinar_session_id
        AND session.organization_id = registration.organization_id
        AND session.webinar_id = registration.webinar_id
    )
  );

SELECT membership.role, membership.status, COUNT(*) AS membership_count
FROM organization_memberships membership
GROUP BY membership.role, membership.status
ORDER BY membership.role, membership.status;

SELECT COUNT(*) AS existing_platform_telegram_manager_bindings
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name = 'telegram_manager_chat_bindings';
