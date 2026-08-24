SELECT COUNT(*) AS legacy_registrations
FROM "registrations";

SELECT COUNT(*) AS registrations_without_session_scope
FROM "registrations" registration
LEFT JOIN "webinar_sessions" session ON session."id" = registration."webinar_session_id"
WHERE session."id" IS NULL
   OR session."organization_id" IS NULL
   OR session."webinar_id" IS NULL;

SELECT COUNT(*) AS registrations_without_normalizable_email
FROM "registrations" registration
JOIN "leads" lead ON lead."id" = registration."lead_id"
WHERE NULLIF(btrim(lower(lead."email")), '') IS NULL;

SELECT lower(lead."email") AS normalized_email, COUNT(DISTINCT lead."id") AS lead_count
FROM "leads" lead
GROUP BY lower(lead."email")
HAVING COUNT(DISTINCT lead."id") > 1;
