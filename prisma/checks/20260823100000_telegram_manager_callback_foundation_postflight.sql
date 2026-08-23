-- Every returned count must be zero after BOT manager binding/callback expand.
SELECT COUNT(*) AS manager_binding_state_violations
FROM telegram_manager_chat_bindings binding
WHERE (binding.status = 'pending_chat' AND (binding.chat_id IS NOT NULL OR binding.chat_id_hash IS NOT NULL OR binding.claimed_at IS NOT NULL))
   OR (binding.status = 'pending_owner' AND (binding.chat_id IS NULL OR binding.chat_id_hash IS NULL OR binding.claimed_at IS NULL OR binding.confirmed_at IS NOT NULL))
   OR (binding.status = 'active' AND (binding.chat_id IS NULL OR binding.chat_id_hash IS NULL OR binding.confirmed_at IS NULL OR binding.confirmed_by_user_id IS NULL))
   OR (binding.status = 'revoked' AND (binding.revoked_at IS NULL OR binding.revoked_by_user_id IS NULL));

SELECT COUNT(*) AS manager_binding_membership_scope_violations
FROM telegram_manager_chat_bindings binding
LEFT JOIN organization_memberships membership
  ON membership.id = binding.membership_id
 AND membership.organization_id = binding.organization_id
WHERE membership.id IS NULL;

SELECT COUNT(*) AS manager_callback_scope_violations
FROM telegram_manager_callbacks callback
LEFT JOIN telegram_manager_chat_bindings binding
  ON binding.id = callback.binding_id
 AND binding.organization_id = callback.organization_id
LEFT JOIN registrations registration
  ON registration.id = callback.registration_id
LEFT JOIN crm_contacts contact
  ON contact.id = callback.crm_contact_id
 AND contact.organization_id = callback.organization_id
WHERE binding.id IS NULL
   OR contact.id IS NULL
   OR registration.id IS NULL
   OR binding.membership_id <> callback.membership_id
   OR registration.organization_id IS DISTINCT FROM callback.organization_id
   OR registration.webinar_id IS DISTINCT FROM callback.webinar_id
   OR registration.webinar_session_id <> callback.webinar_session_id
   OR registration.crm_contact_id IS DISTINCT FROM callback.crm_contact_id;

SELECT COUNT(*) AS manager_callback_state_violations
FROM telegram_manager_callbacks callback
WHERE (callback.status = 'pending' AND (callback.consumed_at IS NOT NULL OR callback.provider_callback_id IS NOT NULL OR callback.result_code IS NOT NULL))
   OR (callback.status IN ('completed', 'rejected', 'expired') AND (callback.consumed_at IS NULL OR callback.result_code IS NULL));

SELECT COUNT(*) AS telegram_bot_event_scope_violations
FROM telegram_bot_events event
LEFT JOIN registrations registration ON registration.id = event.registration_id
WHERE (event.organization_id IS NULL AND (
       event.webinar_id IS NOT NULL OR event.webinar_session_id IS NOT NULL OR event.registration_id IS NOT NULL
       OR event.crm_contact_id IS NOT NULL OR event.membership_id IS NOT NULL OR event.manager_binding_id IS NOT NULL
       OR event.manager_callback_id IS NOT NULL
     ))
   OR (event.registration_id IS NOT NULL AND (
       registration.id IS NULL
       OR registration.organization_id IS DISTINCT FROM event.organization_id
       OR (event.webinar_id IS NOT NULL AND registration.webinar_id IS DISTINCT FROM event.webinar_id)
       OR (event.webinar_session_id IS NOT NULL AND registration.webinar_session_id <> event.webinar_session_id)
       OR (event.crm_contact_id IS NOT NULL AND registration.crm_contact_id IS DISTINCT FROM event.crm_contact_id)
     ));

SELECT COUNT(*) AS telegram_bot_event_sensitive_metadata_violations
FROM telegram_bot_events event
WHERE event.metadata_json ?| ARRAY['token', 'rawToken', 'signedUrl', 'chatId', 'email', 'phone', 'telegramUserId', 'telegramUsername'];
