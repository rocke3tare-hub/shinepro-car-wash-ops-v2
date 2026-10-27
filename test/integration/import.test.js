import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Database } from '../../src/db/database.js';
import { buildConfig } from '../../src/config.js';
import { seed } from '../../src/db/seed.js';
import { planImport, applyImport } from '../../src/cli/import-legacy.js';

test('legacy import: real prototype export, idempotent, stock as movements', () => {
  const db = new Database(':memory:');
  db.migrate();
  const { businessId, branchId } = seed(db, buildConfig({ PASSWORD_PEPPER: 'x' }), {});
  const plan = planImport(fs.readFileSync(new URL('../fixtures/prototype-export.json', import.meta.url), 'utf8'));
  const first = applyImport(db, plan, { businessId, branchId });
  assert.deepEqual(first, { customers: 4, vehicles: 8, workers: 6, inventory: 5 });
  const second = applyImport(db, plan, { businessId, branchId });
  assert.deepEqual(second, { customers: 0, vehicles: 0, workers: 0, inventory: 0 });
  const shampoo = db.get(`SELECT sum(m.quantity) AS stock FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id WHERE i.name = 'Premium shampoo'`);
  assert.equal(shampoo.stock, 18);
  const linked = db.get(`SELECT count(*) AS n FROM vehicles WHERE customer_id IS NOT NULL`).n;
  assert.ok(linked >= 3);
  assert.throws(() => planImport('null'), /does not contain/);
  db.close();
});
