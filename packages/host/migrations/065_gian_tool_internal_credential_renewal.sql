ALTER TABLE tool_credentials
  ADD COLUMN renewable INTEGER NOT NULL DEFAULT 0 CHECK (renewable IN (0, 1));
