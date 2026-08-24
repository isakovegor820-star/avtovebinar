SELECT COUNT(*) AS organizations_without_one_active_scoring_model
FROM (
  SELECT pipeline.organization_id
  FROM crm_pipelines pipeline
  WHERE pipeline.is_default = TRUE
    AND pipeline.status = 'active'
  GROUP BY pipeline.organization_id
) organization
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS active_count
  FROM crm_scoring_rule_sets ruleset
  WHERE ruleset.organization_id = organization.organization_id
    AND ruleset.status = 'active'
) active ON TRUE
WHERE active.active_count <> 1;

SELECT COUNT(*) AS incomplete_active_scoring_models
FROM (
  SELECT ruleset.id
  FROM crm_scoring_rule_sets ruleset
  LEFT JOIN crm_scoring_rules rule
    ON rule.organization_id = ruleset.organization_id
   AND rule.rule_set_id = ruleset.id
  WHERE ruleset.status = 'active'
  GROUP BY ruleset.id
  HAVING COUNT(rule.id) <> 5
      OR COUNT(DISTINCT rule.code) <> 5
) invalid;

SELECT COUNT(*) AS crm_score_factor_scope_mismatches
FROM crm_score_factors factor
LEFT JOIN crm_contacts contact
  ON contact.id = factor.contact_id
 AND contact.organization_id = factor.organization_id
WHERE contact.id IS NULL;

SELECT COUNT(*) AS crm_score_projection_mismatches
FROM crm_contacts contact
LEFT JOIN crm_scoring_rule_sets ruleset
  ON ruleset.id = contact.score_rule_set_id
 AND ruleset.organization_id = contact.organization_id
WHERE contact.score IS DISTINCT FROM COALESCE((
  SELECT SUM(rule.points)::INTEGER
  FROM crm_score_factors factor
  JOIN crm_scoring_rules rule
    ON rule.rule_set_id = ruleset.id
   AND rule.organization_id = factor.organization_id
   AND rule.code = factor.signal_code
  WHERE factor.organization_id = contact.organization_id
    AND factor.contact_id = contact.id
), 0)
   OR (ruleset.id IS NULL AND EXISTS (
     SELECT 1 FROM crm_scoring_rule_sets active
     WHERE active.organization_id = contact.organization_id
       AND active.status = 'active'
   ));

SELECT COUNT(*) AS crm_manual_hot_state_mismatches
FROM crm_contacts contact
LEFT JOIN organization_memberships membership
  ON membership.id = contact.manual_hot_by_membership_id
 AND membership.organization_id = contact.organization_id
WHERE (contact.manual_hot IS NULL AND (
         contact.manual_hot_reason IS NOT NULL
      OR contact.manual_hot_by_membership_id IS NOT NULL
      OR contact.manual_hot_at IS NOT NULL
      OR contact.manual_hot_source IS NOT NULL
   ))
   OR (contact.manual_hot IS NOT NULL AND (
         char_length(btrim(contact.manual_hot_reason)) NOT BETWEEN 3 AND 500
      OR contact.manual_hot_at IS NULL
      OR contact.manual_hot_source NOT IN ('tenant_crm', 'legacy_backfill')
      OR (contact.manual_hot_source = 'tenant_crm' AND (
           membership.id IS NULL OR membership.status <> 'active'
           OR membership.role NOT IN ('owner', 'crm_manager')
         ))
      OR (contact.manual_hot_source = 'legacy_backfill' AND contact.manual_hot_by_membership_id IS NOT NULL)
   ));

SELECT COUNT(*) AS crm_legacy_hot_projection_mismatches
FROM registrations registration
JOIN crm_contacts contact
  ON contact.id = registration.crm_contact_id
 AND contact.organization_id = registration.organization_id
LEFT JOIN crm_scoring_rule_sets ruleset
  ON ruleset.id = contact.score_rule_set_id
 AND ruleset.organization_id = contact.organization_id
WHERE registration.is_hot IS DISTINCT FROM COALESCE(
  contact.manual_hot,
  ruleset.id IS NOT NULL AND contact.score >= ruleset.hot_threshold
);

SELECT COUNT(*) AS crm_tag_scope_mismatches
FROM crm_contact_tags assignment
LEFT JOIN crm_contacts contact
  ON contact.id = assignment.contact_id
 AND contact.organization_id = assignment.organization_id
LEFT JOIN crm_tags tag
  ON tag.id = assignment.tag_id
 AND tag.organization_id = assignment.organization_id
LEFT JOIN organization_memberships membership
  ON membership.id = assignment.assigned_by_membership_id
 AND membership.organization_id = assignment.organization_id
WHERE contact.id IS NULL
   OR tag.id IS NULL
   OR membership.id IS NULL
   OR membership.status <> 'active'
   OR membership.role NOT IN ('owner', 'crm_manager');

SELECT COUNT(*) AS crm_tag_normalization_mismatches
FROM crm_tags
WHERE normalized_name IS DISTINCT FROM lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
   OR color_token NOT IN ('slate', 'blue', 'teal', 'amber', 'red', 'violet');
