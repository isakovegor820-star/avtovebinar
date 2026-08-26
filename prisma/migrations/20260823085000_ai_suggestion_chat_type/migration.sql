-- PostgreSQL requires a newly added enum value to commit before a later
-- migration can use it in constraints or data.
ALTER TYPE "ai_suggestion_type" ADD VALUE IF NOT EXISTS 'chat_moderator_reply';
