-- Public site, customer portal and loyalty.

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  title TEXT NOT NULL,
  description TEXT,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE business_registration_requests (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  city TEXT NOT NULL,
  branch_count INTEGER NOT NULL DEFAULT 1 CHECK (branch_count BETWEEN 1 AND 500),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE complaints (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  job_id TEXT REFERENCES jobs(id),
  category TEXT NOT NULL CHECK (category IN ('quality','damage','billing','service','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_review','resolved','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Loyalty balance is derived from this append-only table, never stored.
CREATE TABLE loyalty_transactions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  job_id TEXT REFERENCES jobs(id),
  points INTEGER NOT NULL CHECK (points <> 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_loyalty_customer ON loyalty_transactions(customer_id);
CREATE UNIQUE INDEX idx_loyalty_one_earn_per_job ON loyalty_transactions(job_id, reason) WHERE job_id IS NOT NULL;
CREATE TRIGGER loyalty_no_update BEFORE UPDATE ON loyalty_transactions BEGIN SELECT RAISE(ABORT, 'loyalty transactions are append-only'); END;
CREATE TRIGGER loyalty_no_delete BEFORE DELETE ON loyalty_transactions BEGIN SELECT RAISE(ABORT, 'loyalty transactions are append-only'); END;
