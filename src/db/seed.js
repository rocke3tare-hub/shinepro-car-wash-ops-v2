import { newId, nowIso } from './database.js';
import { hashPassword } from '../services/auth.js';
import { DEFAULT_SETTINGS } from '../services/common.js';

// Catalog from the original prototype. Services with no Van price are simply
// not offered for vans (the original priced them at 0).
export const SEED_SERVICES = [
  { name: 'Basic Exterior Wash', duration: 25, prices: { small: 250000, sedan: 300000, suv: 400000, van: 500000 }, rules: [['Main washer', 1200], ['Assistant washer', 800], ['Drying worker', 500]], pool: 2500, checklist: ['Exterior cleaned', 'Windows clean', 'Tyres cleaned'] },
  { name: 'Full Wash', duration: 45, prices: { small: 450000, sedan: 550000, suv: 700000, van: 850000 }, rules: [['Exterior worker', 1000], ['Interior worker', 1000], ['Vacuum worker', 700], ['Drying worker', 500]], pool: 3200, checklist: ['Exterior cleaned', 'Windows clean', 'Interior vacuumed', 'Dashboard cleaned', 'Mats cleaned', 'Tyres cleaned'] },
  { name: 'Interior Cleaning', duration: 40, prices: { small: 300000, sedan: 350000, suv: 450000, van: 550000 }, rules: [['Main interior worker', 1800], ['Assistant', 800], ['Quality team share', 200]], pool: 2800, checklist: ['Interior vacuumed', 'Dashboard cleaned', 'Mats cleaned'] },
  { name: 'Engine Wash', duration: 30, prices: { small: 300000, sedan: 300000, suv: 300000, van: 300000 }, rules: [['Main worker', 2000], ['Assistant', 500]], pool: 2500, checklist: ['Engine bay cleaned', 'Electrics protected'] },
  { name: 'Wax', duration: 60, prices: { small: 400000, sedan: 500000, suv: 650000 }, rules: [['Main worker', 2000], ['Assistant', 800]], pool: 2800, checklist: ['Paint cleaned', 'Wax applied evenly', 'No residue'] },
  { name: 'Polishing', duration: 120, prices: { small: 2500000, sedan: 3000000, suv: 4000000 }, rules: [['Main detailer', 2500], ['Assistant detailer', 1000], ['Quality controller', 200]], pool: 3700, checklist: ['Paint polished', 'No visible swirl marks', 'Trim protected'] },
  { name: 'Full Detailing', duration: 150, prices: { small: 5000000, sedan: 6000000, suv: 8000000 }, rules: [['Main detailer', 2000], ['Interior detailer', 1200], ['Assistant', 800], ['Quality controller', 200], ['Team leader', 300]], pool: 4500, checklist: ['Exterior detailed', 'Interior detailed', 'Engine bay cleaned', 'Glass treated', 'Final inspection photos taken'] }
];

function ensure(db, selectSql, params, insert) {
  const row = db.get(selectSql, params);
  if (row) return row.id;
  return insert();
}

/**
 * Idempotent seed: safe to run repeatedly (the original inserted a new business
 * on every run, which then broke public signup).
 */
export function seed(db, config, { businessName = 'ShinePro Car Wash', branchName = 'Tehran · Vanak', ownerEmail, ownerPassword, demo = false, demoPassword } = {}) {
  return db.tx(() => {
    const businessId = ensure(db, 'SELECT id FROM businesses WHERE name = :name', { name: businessName }, () => {
      const id = newId();
      db.run('INSERT INTO businesses(id, name, settings) VALUES (:id, :name, :settings)', { id, name: businessName, settings: JSON.stringify(DEFAULT_SETTINGS) });
      return id;
    });
    const branchId = ensure(db, 'SELECT id FROM branches WHERE business_id = :business AND name = :name', { business: businessId, name: branchName }, () => {
      const id = newId();
      db.run('INSERT INTO branches(id, business_id, name) VALUES (:id, :business, :name)', { id, business: businessId, name: branchName });
      return id;
    });

    const effective = '2026-01-01T00:00:00.000Z';
    SEED_SERVICES.forEach((service, index) => {
      ensure(db, 'SELECT id FROM services WHERE business_id = :business AND name = :name', { business: businessId, name: service.name }, () => {
        const id = newId();
        db.run('INSERT INTO services(id, business_id, name, description, duration_minutes, checklist, sort_order) VALUES (:id, :business, :name, :description, :duration, :checklist, :sort)',
          { id, business: businessId, name: service.name, description: null, duration: service.duration, checklist: JSON.stringify(service.checklist), sort: index });
        for (const [type, amount] of Object.entries(service.prices)) {
          db.run('INSERT INTO service_prices(id, service_id, vehicle_type, amount, effective_from) VALUES (:id, :service, :type, :amount, :from)', { id: newId(), service: id, type, amount, from: effective });
        }
        db.run('INSERT INTO commission_rule_sets(id, service_id, rules, pool_limit_bp, effective_from) VALUES (:id, :service, :rules, :pool, :from)',
          { id: newId(), service: id, rules: JSON.stringify(service.rules.map(([role, basisPoints]) => ({ role, basisPoints }))), pool: service.pool, from: effective });
        return id;
      });
    });

    const created = [];
    const user = (email, name, password, role, branch) => {
      let row = db.get('SELECT id FROM users WHERE email = :email', { email });
      if (!row) {
        const id = newId();
        db.run(`INSERT INTO users(id, email, password_hash, display_name, status) VALUES (:id, :email, :hash, :name, 'active')`, { id, email, hash: hashPassword(password, config.passwordPepper), name });
        row = { id };
        created.push(email);
      }
      const exists = db.get(`SELECT 1 FROM memberships WHERE business_id = :business AND user_id = :user AND role = :role AND COALESCE(branch_id, '*') = COALESCE(:branch, '*')`, { business: businessId, user: row.id, role, branch });
      if (!exists) db.run('INSERT INTO memberships(id, business_id, user_id, role, branch_id) VALUES (:id, :business, :user, :role, :branch)', { id: newId(), business: businessId, user: row.id, role, branch });
      return row.id;
    };
    if (ownerEmail && ownerPassword) user(ownerEmail.toLowerCase(), 'ShinePro Owner', ownerPassword, 'owner', null);

    if (demo) {
      const staff = [
        ['manager@shinepro.local', 'Samira Nouri', 'branch_manager', branchId, 'Branch manager'],
        ['cashier@shinepro.local', 'Arman Karimi', 'cashier', branchId, 'Cashier'],
        ['quality@shinepro.local', 'Nima Ahmadi', 'quality_controller', branchId, 'Quality controller'],
        ['accountant@shinepro.local', 'Leila Hosseini', 'accountant', null, 'Accountant'],
        ['reza@shinepro.local', 'Reza Moradi', 'worker', branchId, 'Detailer'],
        ['kian@shinepro.local', 'Kian Rostami', 'team_leader', branchId, 'Team leader']
      ];
      for (const [email, name, role, branch, title] of staff) {
        const userId = user(email, name, demoPassword, role, branch);
        if (['worker', 'team_leader'].includes(role)) {
          ensure(db, 'SELECT id FROM workers WHERE user_id = :user', { user: userId }, () => {
            const id = newId();
            db.run('INSERT INTO workers(id, business_id, branch_id, user_id, name, title, on_shift) VALUES (:id, :business, :branch, :user, :name, :title, 1)', { id, business: businessId, branch: branchId, user: userId, name, title });
            return id;
          });
        }
      }
      for (const [name, title, onShift] of [['Sara Ebrahimi', 'Interior specialist', 0], ['Omid Rahimi', 'Car-wash worker', 1]]) {
        ensure(db, 'SELECT id FROM workers WHERE business_id = :business AND name = :name', { business: businessId, name }, () => {
          const id = newId();
          db.run('INSERT INTO workers(id, business_id, branch_id, name, title, on_shift) VALUES (:id, :business, :branch, :name, :title, :onShift)', { id, business: businessId, branch: branchId, name, title, onShift });
          return id;
        });
      }
      for (const [name, phone, type] of [['Mina Farhadi', '0912 831 2094', 'loyalty'], ['Atlas Logistics', '021 8877 1919', 'fleet'], ['Nader Kazemi', '0935 441 7810', 'business']]) {
        ensure(db, 'SELECT id FROM customers WHERE business_id = :business AND name = :name', { business: businessId, name }, () => {
          const id = newId();
          db.run('INSERT INTO customers(id, business_id, name, phone, customer_type, credit_limit) VALUES (:id, :business, :name, :phone, :type, :limit)', { id, business: businessId, name, phone, type, limit: type === 'fleet' ? 10000000 : 0 });
          return id;
        });
      }
      for (const [name, category, unit, minimum, cost, stock] of [['Premium shampoo', 'Chemicals', 'L', 10, 180000, 18], ['Interior cleaner', 'Chemicals', 'L', 8, 210000, 6], ['Microfiber cloths', 'Supplies', 'pcs', 20, 39000, 42], ['Tyre cleaner', 'Chemicals', 'L', 6, 160000, 3]]) {
        ensure(db, 'SELECT id FROM inventory_items WHERE branch_id = :branch AND name = :name', { branch: branchId, name }, () => {
          const id = newId();
          db.run('INSERT INTO inventory_items(id, business_id, branch_id, name, category, unit, minimum_stock, unit_cost) VALUES (:id, :business, :branch, :name, :category, :unit, :minimum, :cost)', { id, business: businessId, branch: branchId, name, category, unit, minimum, cost });
          db.run(`INSERT INTO stock_movements(id, item_id, kind, quantity, unit_cost, reason, created_by) VALUES (:id, :item, 'purchase', :qty, :cost, 'Opening stock', 'seed')`, { id: newId(), item: id, qty: stock, cost });
          return id;
        });
      }
      ensure(db, `SELECT id FROM offers WHERE business_id = :business AND title = :title`, { business: businessId, title: 'First visit, better remembered' }, () => {
        const id = newId();
        db.run(`INSERT INTO offers(id, business_id, title, description, label, status, starts_at) VALUES (:id, :business, :title, :description, 'NEW MEMBER', 'active', :start)`,
          { id, business: businessId, title: 'First visit, better remembered', description: 'Create your member account and keep every digital receipt in one place.', start: nowIso() });
        return id;
      });
    }
    return { businessId, branchId, createdUsers: created };
  });
}
