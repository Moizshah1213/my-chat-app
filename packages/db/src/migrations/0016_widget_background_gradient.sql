ALTER TABLE widget_settings
  ADD COLUMN IF NOT EXISTS background_gradient boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS background_gradient_color text NOT NULL DEFAULT '#19191d';
