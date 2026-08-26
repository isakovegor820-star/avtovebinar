-- Every returned count must be zero after identity hardening.
SELECT COUNT(*) AS unsafe_runtime_synthetic_identity_violations
FROM webinar_chat_messages
WHERE is_synthetic = true
  AND NOT (
    (message_type = 'prepared_question'
      AND author_name = 'Подготовленный вопрос'
      AND author_role = 'Подготовленный вопрос')
    OR (message_type = 'ai_moderator'
      AND author_name = 'AI-модератор'
      AND author_role = 'AI-модератор')
  );

SELECT COUNT(*) AS unsafe_scenario_identity_violations
FROM chat_scenario_messages
WHERE NOT (
  (kind = 'ai_moderator' AND author_label = 'AI-модератор')
  OR (kind = 'system' AND author_label = 'Система АСПБ')
  OR (kind IN ('prepared_question', 'moderator_notice', 'author_prompt')
    AND author_label = 'Подготовленный вопрос')
);
