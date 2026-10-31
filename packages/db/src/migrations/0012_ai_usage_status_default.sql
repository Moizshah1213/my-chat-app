-- The original AI usage event table requires status; monthly rollups don't use it.
ALTER TABLE ai_usage ALTER COLUMN status SET DEFAULT 'success';
