-- D1 Schema for contact form and feedback submissions
-- Run with: wrangler d1 execute bugdays-contact --file=./schema.sql

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'contact',
  tool TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster queries by date
CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at);

-- Index for filtering by type
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(type);
