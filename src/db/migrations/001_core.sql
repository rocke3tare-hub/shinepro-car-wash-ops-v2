-- ShinePro v2 core schema (SQLite). Money columns are INTEGER toman.
-- Every table that belongs to a tenant carries business_id so every query can
-- be scoped; branch-owned rows also carry branch_id.

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'IRR_TOMAN',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tehran',
  bays TEXT NOT NULL DEFAULT '["Bay 01","Bay 02","Bay 03","Bay 04","Bay 05"]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (business_id, name)
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  phone TEXT,
  customer_type TEXT NOT NULL DEFAULT 'walk_in' CHECK (customer_type IN ('walk_in','member','loyalty','fleet','business')),
  note TEXT,
  credit_limit INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','fa')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  legacy_source_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_customers_business_name ON customers(business_id, name);
CREATE INDEX idx_customers_business_phone ON customers(business_id, phone);
CREATE UNIQUE INDEX idx_customers_legacy ON customers(business_id, legacy_source_id) WHERE legacy_source_id IS NOT NULL;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  customer_id TEXT UNIQUE REFERENCES customers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

-- One row per (business, user, role, branch scope). branch_id NULL = every branch.
CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','company_admin','branch_manager','accountant','cashier','quality_controller','team_leader','worker','inventory_manager','customer')),
  branch_id TEXT REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_memberships_unique ON memberships(business_id, user_id, role, COALESCE(branch_id, '*'));
CREATE INDEX idx_memberships_user ON memberships(user_id, status);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  succeeded INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_login_attempts_email ON login_attempts(email, created_at);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip_hash, created_at);

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  user_id TEXT UNIQUE REFERENCES users(id),
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Car-wash worker',
  phone TEXT,
  on_shift INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  customer_id TEXT REFERENCES customers(id),
  plate TEXT NOT NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('small','sedan','suv','van')),
  brand TEXT,
  model TEXT,
  colour TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (business_id, plate)
);
CREATE INDEX idx_vehicles_customer ON vehicles(customer_id);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes > 0),
  checklist TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (business_id, name)
);

-- Price history. The price in force is the latest effective_from <= now.
CREATE TABLE service_prices (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id),
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('small','sedan','suv','van')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  effective_from TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (service_id, vehicle_type, effective_from)
);

-- Commission rule-set history; rules = [{"role":"Main washer","basisPoints":1200}].
CREATE TABLE commission_rule_sets (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id),
  rules TEXT NOT NULL,
  pool_limit_bp INTEGER NOT NULL CHECK (pool_limit_bp BETWEEN 0 AND 10000),
  effective_from TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (service_id, effective_from)
);

CREATE TABLE counters (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  key TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (business_id, key)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  code TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  plate TEXT NOT NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('small','sedan','suv','van')),
  vehicle_label TEXT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  service_id TEXT NOT NULL REFERENCES services(id),
  service_name TEXT NOT NULL,
  price_snapshot_id TEXT NOT NULL REFERENCES service_prices(id),
  rule_set_id TEXT REFERENCES commission_rule_sets(id),
  original_price INTEGER NOT NULL CHECK (original_price > 0),
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  discount_reason TEXT,
  discount_status TEXT NOT NULL DEFAULT 'none' CHECK (discount_status IN ('none','pending','approved','rejected')),
  final_price INTEGER NOT NULL CHECK (final_price >= 0),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','assigned','in_progress','paused','ready_for_quality','rework_required','ready_for_payment','completed','cancelled','refunded')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  bay TEXT,
  notes TEXT,
  existing_damage TEXT,
  checklist TEXT NOT NULL DEFAULT '[]',
  cancel_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  legacy_source_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (business_id, code),
  CHECK (discount <= original_price),
  CHECK (final_price = original_price - discount)
);
CREATE INDEX idx_jobs_branch_status ON jobs(branch_id, status, created_at);
CREATE INDEX idx_jobs_business_created ON jobs(business_id, created_at);
CREATE INDEX idx_jobs_customer ON jobs(customer_id);
CREATE UNIQUE INDEX idx_jobs_legacy ON jobs(business_id, legacy_source_id) WHERE legacy_source_id IS NOT NULL;

CREATE TABLE job_assignments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  role_label TEXT NOT NULL,
  commission_type TEXT NOT NULL CHECK (commission_type IN ('percentage','fixed')),
  basis_points INTEGER NOT NULL DEFAULT 0 CHECK (basis_points BETWEEN 0 AND 10000),
  fixed_amount INTEGER NOT NULL DEFAULT 0 CHECK (fixed_amount >= 0),
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','started','completed','approved','earned','reversed','removed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_assignment_unique_worker ON job_assignments(job_id, worker_id) WHERE status <> 'removed';
CREATE INDEX idx_assignments_worker ON job_assignments(worker_id);

CREATE TABLE quality_checks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  inspector_user_id TEXT NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','rework')),
  results TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE cash_sessions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','review_required','reviewed')),
  opening_cash INTEGER NOT NULL CHECK (opening_cash >= 0),
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  counted_cash INTEGER,
  expected_cash INTEGER,
  difference INTEGER,
  explanation TEXT,
  closed_by TEXT,
  closed_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT
);
-- At most one open register per branch.
CREATE UNIQUE INDEX idx_cash_one_open ON cash_sessions(branch_id) WHERE status = 'open';

CREATE TABLE cash_movements (
  id TEXT PRIMARY KEY,
  cash_session_id TEXT NOT NULL REFERENCES cash_sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment','tip','refund','expense','payout','added','removed')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  reference_type TEXT,
  reference_id TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_cash_movements_session ON cash_movements(cash_session_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  tip_amount INTEGER NOT NULL DEFAULT 0 CHECK (tip_amount >= 0),
  tip_method TEXT CHECK (tip_method IN ('cash','card','bank_transfer')),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','refunded')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (business_id, idempotency_key)
);
CREATE UNIQUE INDEX idx_one_confirmed_payment_per_job ON payments(job_id) WHERE status = 'confirmed';

CREATE TABLE payment_parts (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  method TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','customer_credit')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reference TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT REFERENCES branches(id),
  kind TEXT NOT NULL CHECK (kind IN ('discount','refund','expense','cash_difference')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_approvals_business_status ON approvals(business_id, status, created_at);
CREATE UNIQUE INDEX idx_one_pending_approval ON approvals(kind, subject_id) WHERE status = 'pending';

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','customer_credit')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE worker_earnings (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  job_id TEXT REFERENCES jobs(id),
  assignment_id TEXT REFERENCES job_assignments(id),
  kind TEXT NOT NULL CHECK (kind IN ('commission','tip','adjustment')),
  amount INTEGER NOT NULL,
  note TEXT,
  payout_id TEXT REFERENCES payouts(id),
  earned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_earnings_worker ON worker_earnings(worker_id, payout_id);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  category TEXT NOT NULL CHECK (category IN ('direct_job','daily_branch','monthly_operating','inventory_purchase','maintenance','other')),
  description TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  payment_source TEXT NOT NULL CHECK (payment_source IN ('cash','card','bank_transfer')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','paid')),
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT
);
CREATE INDEX idx_expenses_branch ON expenses(branch_id, created_at);

CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Supplies',
  unit TEXT NOT NULL,
  minimum_stock INTEGER NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  unit_cost INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (branch_id, name)
);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase','usage','waste','return','adjustment')),
  quantity INTEGER NOT NULL CHECK (quantity <> 0),
  unit_cost INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_stock_item ON stock_movements(item_id);

CREATE TABLE ledger_transactions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id TEXT REFERENCES branches(id),
  event_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),
  account TEXT NOT NULL,
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX idx_ledger_entries_tx ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_entries_account ON ledger_entries(account);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT,
  branch_id TEXT,
  user_id TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_values TEXT,
  after_values TEXT,
  reason TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_business ON audit_events(business_id, id);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);

-- Financial and audit history is append-only.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;
CREATE TRIGGER ledger_tx_no_update BEFORE UPDATE ON ledger_transactions BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_tx_no_delete BEFORE DELETE ON ledger_transactions BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER cash_movement_no_update BEFORE UPDATE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;
CREATE TRIGGER cash_movement_no_delete BEFORE DELETE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;
CREATE TRIGGER stock_movement_no_update BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END;
CREATE TRIGGER stock_movement_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END;
CREATE TRIGGER payment_part_no_update BEFORE UPDATE ON payment_parts BEGIN SELECT RAISE(ABORT, 'payment parts are immutable'); END;
CREATE TRIGGER payment_part_no_delete BEFORE DELETE ON payment_parts BEGIN SELECT RAISE(ABORT, 'payment parts are immutable'); END;
