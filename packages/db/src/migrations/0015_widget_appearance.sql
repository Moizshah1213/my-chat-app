ALTER TABLE widget_settings
  ALTER COLUMN color SET DEFAULT '#303033',
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'dark',
  ADD COLUMN IF NOT EXISTS background_color text NOT NULL DEFAULT '#000000',
  ADD COLUMN IF NOT EXISTS button_color text NOT NULL DEFAULT '#f4f4f5',
  ADD COLUMN IF NOT EXISTS agent_bubble_color text NOT NULL DEFAULT '#1b1b1c';

UPDATE widget_settings
SET color = '#303033'
WHERE color = '#4f46e5';
