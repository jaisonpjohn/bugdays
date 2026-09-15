CREATE TABLE IF NOT EXISTS ip_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ip_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cloud', 'hosting', 'cdn', 'crawler', 'service')),
  method TEXT NOT NULL CHECK (method IN ('official', 'bgp')),
  url TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT '',
  range_count INTEGER NOT NULL,
  asns_json TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ip_ranges (
  lookup_key TEXT NOT NULL,
  cidr TEXT NOT NULL,
  source_id TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (lookup_key, cidr, source_id, service, region),
  FOREIGN KEY (source_id) REFERENCES ip_sources(id) ON DELETE CASCADE
) WITHOUT ROWID;
