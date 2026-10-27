// Import master data from the original browser prototype (localStorage key
// "shinepro-ops-v1"). Usage:
//   npm run import:legacy -- path\to\shinepro-export.json            (preview only)
//   npm run import:legacy -- path\to\shinepro-export.json --apply    (write)
//
// Imported: customers, vehicles (from job plates), workers, inventory items
// with their stock as an opening movement. NOT imported: jobs, payments, cash,
// expenses and earnings. Prototype financial records were never backed by a
// ledger, so re-entering them would create unbalanced books.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildConfig, loadEnvFile } from '../config.js';
import { Database, newId } from '../db/database.js';

const TYPE_MAP = { 'walk-in': 'walk_in', walk_in: 'walk_in', loyalty: 'loyalty', fleet: 'fleet', business: 'business', member: 'member' };
const VEHICLE_MAP = { small: 'small', sedan: 'sedan', suv: 'suv', van: 'van' };
const clean = (value, max = 120) => (value == null ? '' : String(value)).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

export function planImport(raw) {
  const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!state || typeof state !== 'object') throw new Error('The file does not contain a ShinePro prototype export.');
  const list = key => (Array.isArray(state[key]) ? state[key] : []);
  const warnings = [];
  const customers = [];
  const seenCustomers = new Set();
  for (const c of list('customers')) {
    const name = clean(c.name);
    if (!name) { warnings.push(`Skipped a customer without a name (${c.id ?? '?'}).`); continue; }
    const key = `${name.toLowerCase()}|${clean(c.phone, 32)}`;
    if (seenCustomers.has(key)) { warnings.push(`Skipped duplicate customer "${name}".`); continue; }
    seenCustomers.add(key);
    customers.push({ legacyId: clean(c.id, 60) || null, name, phone: clean(c.phone, 32) || null, type: TYPE_MAP[clean(c.type).toLowerCase()] || 'walk_in', note: clean(c.note, 500) || null });
  }
  const vehicles = [];
  const seenPlates = new Set();
  for (const j of list('jobs')) {
    const plate = clean(j.plate, 32).replace(/\s+/g, ' ');
    if (!plate || seenPlates.has(plate)) continue;
    seenPlates.add(plate);
    const type = VEHICLE_MAP[clean(j.vehicleType).toLowerCase()];
    if (!type) { warnings.push(`Vehicle ${plate} has an unknown type "${j.vehicleType}"; imported as sedan.`); }
    vehicles.push({ plate, type: type || 'sedan', brand: clean(j.brand, 40) || null, model: clean(j.model, 40) || null, colour: clean(j.color, 30) || null, customerName: clean(j.customer) });
  }
  const workers = list('workers').filter(w => clean(w.name)).map(w => ({ name: clean(w.name, 80), title: clean(w.title || w.role, 60) || 'Car-wash worker', onShift: Boolean(w.present) }));
  const inventory = list('inventory').filter(i => clean(i.name)).map(i => {
    const stock = Math.max(0, Math.trunc(Number(i.stock) || 0));
    if (Number(i.stock) < 0) warnings.push(`Inventory "${i.name}" had negative stock; imported as 0.`);
    return { name: clean(i.name, 80), category: clean(i.category, 40) || 'Supplies', unit: clean(i.unit, 12) || 'pcs', minimum: Math.max(0, Math.trunc(Number(i.minimum) || 0)), cost: Math.max(0, Math.trunc(Number(i.cost) || 0)), stock, active: clean(i.status).toLowerCase() !== 'inactive' };
  });
  const skipped = { jobs: list('jobs').length, expenses: list('expenses').length };
  return { customers, vehicles, workers, inventory, warnings, skipped };
}

export function applyImport(db, plan, { businessId, branchId }) {
  return db.tx(() => {
    const counts = { customers: 0, vehicles: 0, workers: 0, inventory: 0 };
    const customerIds = new Map();
    for (const c of plan.customers) {
      const existing = (c.legacyId && db.get('SELECT id FROM customers WHERE business_id = :b AND legacy_source_id = :l', { b: businessId, l: c.legacyId }))
        || db.get('SELECT id FROM customers WHERE business_id = :b AND name = :n AND COALESCE(phone, \'\') = COALESCE(:p, \'\')', { b: businessId, n: c.name, p: c.phone });
      if (existing) { customerIds.set(c.name, existing.id); continue; }
      const id = newId();
      db.run('INSERT INTO customers(id, business_id, name, phone, customer_type, note, legacy_source_id) VALUES (:id, :b, :n, :p, :t, :note, :l)', { id, b: businessId, n: c.name, p: c.phone, t: c.type, note: c.note, l: c.legacyId });
      customerIds.set(c.name, id); counts.customers += 1;
    }
    for (const v of plan.vehicles) {
      if (db.get('SELECT 1 FROM vehicles WHERE business_id = :b AND plate = :p', { b: businessId, p: v.plate })) continue;
      db.run('INSERT INTO vehicles(id, business_id, customer_id, plate, vehicle_type, brand, model, colour) VALUES (:id, :b, :c, :p, :t, :br, :m, :co)',
        { id: newId(), b: businessId, c: customerIds.get(v.customerName) ?? null, p: v.plate, t: v.type, br: v.brand, m: v.model, co: v.colour });
      counts.vehicles += 1;
    }
    for (const w of plan.workers) {
      if (db.get('SELECT 1 FROM workers WHERE business_id = :b AND name = :n', { b: businessId, n: w.name })) continue;
      db.run('INSERT INTO workers(id, business_id, branch_id, name, title, on_shift) VALUES (:id, :b, :br, :n, :t, :s)', { id: newId(), b: businessId, br: branchId, n: w.name, t: w.title, s: w.onShift ? 1 : 0 });
      counts.workers += 1;
    }
    for (const i of plan.inventory) {
      if (db.get('SELECT 1 FROM inventory_items WHERE branch_id = :br AND name = :n', { br: branchId, n: i.name })) continue;
      const id = newId();
      db.run('INSERT INTO inventory_items(id, business_id, branch_id, name, category, unit, minimum_stock, unit_cost, status) VALUES (:id, :b, :br, :n, :c, :u, :m, :cost, :s)',
        { id, b: businessId, br: branchId, n: i.name, c: i.category, u: i.unit, m: i.minimum, cost: i.cost, s: i.active ? 'active' : 'inactive' });
      if (i.stock > 0) db.run(`INSERT INTO stock_movements(id, item_id, kind, quantity, unit_cost, reason, created_by) VALUES (:id, :item, 'adjustment', :q, :cost, 'Opening stock imported from prototype', 'import')`, { id: newId(), item: id, q: i.stock, cost: i.cost });
      counts.inventory += 1;
    }
    db.run(`INSERT INTO audit_events(business_id, branch_id, action, entity_type, after_values, reason) VALUES (:b, :br, 'import.legacy', 'business', :after, 'Prototype master data import')`, { b: businessId, br: branchId, after: JSON.stringify(counts) });
    return counts;
  });
}

function main() {
  const file = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('Usage: npm run import:legacy -- <export.json> [--apply]');
    console.error('Export the prototype data in the browser console with: copy(localStorage.getItem("shinepro-ops-v1")) and save it to a .json file.');
    process.exit(1);
  }
  const plan = planImport(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  console.log(`Customers: ${plan.customers.length} · Vehicles: ${plan.vehicles.length} · Workers: ${plan.workers.length} · Inventory items: ${plan.inventory.length}`);
  console.log(`Not imported (financial history): ${plan.skipped.jobs} job(s), ${plan.skipped.expenses} expense(s).`);
  plan.warnings.forEach(w => console.log(`Warning: ${w}`));
  if (!apply) { console.log('\nPreview only. Re-run with --apply to write these records.'); return; }
  loadEnvFile();
  const config = buildConfig();
  const db = new Database(config.databaseFile);
  db.migrate();
  const business = db.get(`SELECT id FROM businesses WHERE status = 'active' ORDER BY created_at LIMIT 1`);
  const branch = business && db.get(`SELECT id FROM branches WHERE business_id = :b AND status = 'active' ORDER BY created_at LIMIT 1`, { b: business.id });
  if (!branch) { console.error('Run "npm run db:seed" first so there is a business and branch to import into.'); process.exit(1); }
  const counts = applyImport(db, plan, { businessId: business.id, branchId: branch.id });
  db.close();
  console.log(`Imported: ${JSON.stringify(counts)}. Running the import again skips records that already exist.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
