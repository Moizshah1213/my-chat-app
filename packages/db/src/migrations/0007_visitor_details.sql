-- 0007_visitor_details.sql
ALTER TABLE visitors
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS number bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS browser text,
  ADD COLUMN IF NOT EXISTS os text,
  ADD COLUMN IF NOT EXISTS device text,
  ADD COLUMN IF NOT EXISTS current_url text,
  ADD COLUMN IF NOT EXISTS referrer text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notes text;

-- Length limits via check constraints (idempotent-ish via DO).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitors_display_name_len') THEN
    ALTER TABLE visitors ADD CONSTRAINT visitors_display_name_len CHECK (display_name IS NULL OR char_length(display_name) <= 80);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitors_notes_len') THEN
    ALTER TABLE visitors ADD CONSTRAINT visitors_notes_len CHECK (notes IS NULL OR char_length(notes) <= 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitors_tags_len') THEN
    ALTER TABLE visitors ADD CONSTRAINT visitors_tags_len CHECK (array_length(tags,1) IS NULL OR array_length(tags,1) <= 20);
  END IF;
END $$;
