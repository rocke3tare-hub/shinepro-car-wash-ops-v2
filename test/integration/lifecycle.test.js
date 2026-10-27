import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, signedIn, client } from '../helpers.js';

const env = await startTestServer();
test.after(() => env.close());

const owner = await signedIn(env.base, 'owner@shinepro.local');
const manager = await signedIn(env.base, 'manager@shinepro.local');
const cashier = await signedIn(env.base, 'cashier@shinepro.local');
const quality = await signedIn(env.base, 'quality@shinepro.local');
const accountant = await signedIn(env.base, 'accountant@shinepro.local');
const reza = await signedIn(env.base, 'reza@shinepro.local');
const kian = await signedIn(env.base, 'kian@shinepro.local');

const services = (await owner.get('/api/services')).body.data;
const fullWash = services.find(s => s.name === 'Full Wash');
const wax = services.find(s => s.name === 'Wax');
const workers = (await owner.get('/api/workers')).body.data;
const rezaWorker = workers.find(w => w.name === 'Reza Moradi');
const kianWorker = workers.find(w => w.name === 'Kian Rostami');
const branchId = env.seeded.branchId;
const ok = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body.data; };
const fail = (result, status, code) => { assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.error, code); };
const allPassed = job => job.checklist.map(item => ({ item, passed: true }));

async function newJob(by, overrides = {}) {
  return ok(await by.post('/api/jobs', {
    branchId, serviceId: fullWash.id, vehicleType: 'sedan', plate: `21 ب ${Math.floor(Math.random() * 900 + 100)} ایران 11`, customerName: 'Mina Farhadi',
    assignments: [{ workerId: rezaWorker.id, role: 'Exterior worker' }, { workerId: kianWorker.id, role: 'Vacuum worker' }], ...overrides
  }), 201);
}

async function toReadyForPayment(job) {
  ok(await reza.post(`/api/jobs/${job.id}/actions/start`, {}));
  ok(await reza.post(`/api/jobs/${job.id}/actions/submit_for_quality`, {}));
  return ok(await quality.post(`/api/jobs/${job.id}/actions/approve_quality`, { results: allPassed(job) }));
}

test('session: /api/me exposes roles, permissions and branch scope', async () => {
  const me = ok(await cashier.get('/api/me'));
  assert.deepEqual(me.roles.map(r => r.role), ['cashier']);
  assert.ok(me.permissions.includes('payments.create'));
  assert.ok(!me.permissions.includes('approvals.refund'));
  assert.equal(me.branches.length, 1);
});

test('pricing: a service not offered for a vehicle type is rejected (no 0-toman jobs)', async () => {
  fail(await cashier.post('/api/jobs', { branchId, serviceId: wax.id, vehicleType: 'van', plate: 'VAN 1' }), 422, 'SERVICE_NOT_OFFERED');
  fail(await cashier.post('/api/jobs', { branchId, serviceId: fullWash.id, vehicleType: 'sedan', plate: 'D 1', discount: 550001, discountReason: 'x' }), 422, 'VALIDATION_ERROR');
});

test('full lifecycle: quality gate, idempotent split payment, tips, commissions, ledger', async () => {
  let job = await newJob(cashier, { discount: 50000, discountReason: 'Returning customer' });
  assert.equal(job.status, 'assigned');
  assert.equal(job.finalPrice, 500000);
  assert.equal(job.discountStatus, 'approved'); // 9.1% is under the 10% threshold

  fail(await cashier.post(`/api/jobs/${job.id}/payments`, { parts: [{ method: 'card', amount: 500000 }] }, { 'Idempotency-Key': 'k-early' }), 422, 'JOB_NOT_READY_FOR_PAYMENT');

  // Workers see only their own jobs and can only do work actions.
  const rezaJobs = ok(await reza.get('/api/jobs'));
  assert.ok(rezaJobs.every(j => j.workers.includes('Reza Moradi')));
  fail(await reza.post(`/api/jobs/${job.id}/actions/cancel`, { reason: 'no' }), 403, 'PERMISSION_DENIED');
  ok(await reza.post(`/api/jobs/${job.id}/actions/start`, {}));
  job = ok(await reza.post(`/api/jobs/${job.id}/actions/submit_for_quality`, {}));
  assert.equal(job.status, 'ready_for_quality');

  // Quality needs every checklist item ticked.
  fail(await quality.post(`/api/jobs/${job.id}/actions/approve_quality`, { results: [] }), 422, 'ACTION_BLOCKED');
  job = ok(await quality.post(`/api/jobs/${job.id}/actions/approve_quality`, { results: allPassed(job) }));
  assert.equal(job.status, 'ready_for_payment');

  // Cash needs an open register.
  const pay = { parts: [{ method: 'cash', amount: 200000 }, { method: 'card', amount: 300000 }], tipAmount: 20000, tipMethod: 'cash' };
  fail(await cashier.post(`/api/jobs/${job.id}/payments`, pay, { 'Idempotency-Key': 'pay-1' }), 422, 'CASH_REGISTER_CLOSED');
  ok(await cashier.post('/api/cash/open', { branchId, openingCash: 2000000 }));
  fail(await cashier.post(`/api/jobs/${job.id}/payments`, pay), 422, 'VALIDATION_ERROR'); // key required

  const paid = ok(await cashier.post(`/api/jobs/${job.id}/payments`, pay, { 'Idempotency-Key': 'pay-1' }), 201);
  assert.equal(paid.job.status, 'completed');
  assert.equal(paid.job.paymentStatus, 'paid');
  const retry = ok(await cashier.post(`/api/jobs/${job.id}/payments`, pay, { 'Idempotency-Key': 'pay-1' }));
  assert.equal(retry.duplicate, true);
  fail(await cashier.post(`/api/jobs/${job.id}/payments`, { ...pay, tipAmount: 1 }, { 'Idempotency-Key': 'pay-1' }), 409, 'IDEMPOTENCY_KEY_REUSED');
  fail(await cashier.post(`/api/jobs/${job.id}/payments`, pay, { 'Idempotency-Key': 'pay-2' }), 422, 'JOB_NOT_READY_FOR_PAYMENT');

  // Commissions: 10% and 7% of the discounted 500,000; tip split evenly.
  const rezaStatement = ok(await reza.get(`/api/earnings/${rezaWorker.id}`));
  assert.equal(rezaStatement.unpaidCommission, 50000);
  assert.equal(rezaStatement.unpaidTips, 10000);
  fail(await reza.get(`/api/earnings/${kianWorker.id}`), 403, 'PERMISSION_DENIED');
  const kianStatement = ok(await owner.get(`/api/earnings/${kianWorker.id}`));
  assert.equal(kianStatement.unpaidCommission, 35000);

  const cash = ok(await cashier.get(`/api/cash?branchId=${branchId}`));
  assert.equal(cash.current.expectedCash, 2000000 + 200000 + 20000);
  const tb = ok(await accountant.get('/api/reports/trial-balance'));
  assert.equal(tb.balanced, true);
  const byAccount = Object.fromEntries(tb.accounts.map(a => [a.account, a.balance]));
  assert.equal(byAccount.service_revenue, 500000);
  assert.equal(byAccount.tips_payable, 20000);
  assert.equal(byAccount.commissions_payable, 85000);

  // A completed job is locked.
  fail(await cashier.patch(`/api/jobs/${job.id}`, { notes: 'late edit' }), 422, 'JOB_LOCKED');
});

test('refunds: four-eyes approval, commission reversal, cash out, ledger stays balanced', async () => {
  let job = await newJob(cashier);
  job = await toReadyForPayment(job);
  ok(await cashier.post(`/api/jobs/${job.id}/payments`, { parts: [{ method: 'cash', amount: 550000 }] }, { 'Idempotency-Key': `pay-${job.id}` }), 201);
  fail(await cashier.post(`/api/jobs/${job.id}/refunds`, { amount: 600000, method: 'cash', reason: 'Damage' }), 422, 'VALIDATION_ERROR');
  ok(await cashier.post(`/api/jobs/${job.id}/refunds`, { amount: 550000, method: 'cash', reason: 'Customer complaint' }), 201);
  fail(await cashier.post(`/api/jobs/${job.id}/refunds`, { amount: 1, method: 'cash', reason: 'again' }), 409, 'REFUND_PENDING');

  const pending = ok(await accountant.get('/api/approvals')).find(a => a.kind === 'refund' && a.subjectId === job.id);
  fail(await cashier.post(`/api/approvals/${pending.id}/decision`, { decision: 'approve' }), 403, 'PERMISSION_DENIED');
  ok(await accountant.post(`/api/approvals/${pending.id}/decision`, { decision: 'approve' }));
  fail(await accountant.post(`/api/approvals/${pending.id}/decision`, { decision: 'approve' }), 409, 'ALREADY_DECIDED');

  job = ok(await owner.get(`/api/jobs/${job.id}`));
  assert.equal(job.status, 'refunded');
  assert.ok(job.assignments.every(a => a.status === 'reversed'));
  const statement = ok(await owner.get(`/api/earnings/${rezaWorker.id}`));
  assert.ok(statement.lines.some(l => l.kind === 'adjustment' && l.amount === -55000));
  assert.equal(ok(await accountant.get('/api/reports/trial-balance')).balanced, true);
});

test('discounts above the threshold need someone else to approve before payment', async () => {
  let job = await newJob(manager, { discount: 100000, discountReason: 'Fleet rate' });
  assert.equal(job.discountStatus, 'pending');
  job = await toReadyForPayment(job);
  fail(await cashier.post(`/api/jobs/${job.id}/payments`, { parts: [{ method: 'card', amount: 450000 }] }, { 'Idempotency-Key': `d-${job.id}` }), 422, 'DISCOUNT_PENDING');
  const approval = ok(await manager.get('/api/approvals')).find(a => a.kind === 'discount' && a.subjectId === job.id);
  assert.equal(approval.selfRequested, true);
  fail(await manager.post(`/api/approvals/${approval.id}/decision`, { decision: 'approve' }), 403, 'SELF_APPROVAL_DENIED');
  fail(await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'reject' }), 422, 'VALIDATION_ERROR'); // note required
  ok(await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'reject', note: 'Fleet rate expired' }));
  job = ok(await owner.get(`/api/jobs/${job.id}`));
  assert.equal(job.finalPrice, 550000);
  assert.equal(job.discountStatus, 'rejected');
  ok(await cashier.post(`/api/jobs/${job.id}/payments`, { parts: [{ method: 'card', amount: 550000 }] }, { 'Idempotency-Key': `d2-${job.id}` }), 201);
});

test('quality: a participating worker cannot approve their own job', async () => {
  const job = await newJob(manager, { assignments: [{ workerId: rezaWorker.id, role: 'Exterior worker' }] });
  ok(await reza.post(`/api/jobs/${job.id}/actions/start`, {}));
  ok(await reza.post(`/api/jobs/${job.id}/actions/submit_for_quality`, {}));
  fail(await kian.post(`/api/jobs/${job.id}/actions/approve_quality`, { results: allPassed(job) }), 403, 'PERMISSION_DENIED');
  const rework = ok(await quality.post(`/api/jobs/${job.id}/actions/request_rework`, { reason: 'Rear mat still dirty', results: allPassed(job) }));
  assert.equal(rework.status, 'rework_required');
  assert.equal(rework.quality.at(-1).outcome, 'rework');
});

test('commission pool limit and role validation on assignment', async () => {
  fail(await manager.post('/api/jobs', { branchId, serviceId: fullWash.id, vehicleType: 'sedan', plate: 'POOL 1', assignments: [{ workerId: rezaWorker.id, role: 'Made-up role' }] }), 422, 'VALIDATION_ERROR');
  fail(await manager.post('/api/jobs', { branchId, serviceId: fullWash.id, vehicleType: 'sedan', plate: 'POOL 2', assignments: [{ workerId: rezaWorker.id, role: 'Exterior worker' }, { workerId: rezaWorker.id, role: 'Interior worker' }] }), 422, 'VALIDATION_ERROR');
});

test('cash close: differences above the threshold need review; books follow the drawer', async () => {
  const before = ok(await cashier.get(`/api/cash?branchId=${branchId}`)).current.expectedCash;
  fail(await cashier.post('/api/cash/movements', { branchId, kind: 'removed', amount: before + 1, note: 'deposit' }), 422, 'INSUFFICIENT_CASH');
  ok(await cashier.post('/api/cash/movements', { branchId, kind: 'removed', amount: 1000000, note: 'Bank deposit' }));
  const expected = before - 1000000;
  fail(await cashier.post('/api/cash/close', { branchId, countedCash: expected - 600000 }), 422, 'VALIDATION_ERROR'); // explanation required
  const closed = ok(await cashier.post('/api/cash/close', { branchId, countedCash: expected - 600000, explanation: 'Change given twice' }));
  assert.equal(closed.current, null);
  assert.equal(closed.recent[0].status, 'review_required');
  assert.equal(closed.recent[0].difference, -600000);
  const approval = ok(await accountant.get('/api/approvals')).find(a => a.kind === 'cash_difference');
  ok(await accountant.post(`/api/approvals/${approval.id}/decision`, { decision: 'approve', note: 'Accepted' }));
  assert.equal(ok(await accountant.get('/api/reports/trial-balance')).balanced, true);
  ok(await cashier.post('/api/cash/open', { branchId, openingCash: 1000000 }));
});

test('expenses: submit, approve by someone else, pay from the drawer', async () => {
  const expense = ok(await cashier.post('/api/expenses', { branchId, category: 'daily_branch', description: 'Team lunch', amount: 460000, paymentSource: 'cash' }), 201);
  fail(await manager.post(`/api/expenses/${expense.id}/pay`), 422, 'EXPENSE_NOT_APPROVED');
  const approval = ok(await manager.get('/api/approvals')).find(a => a.kind === 'expense' && a.subjectId === expense.id);
  ok(await manager.post(`/api/approvals/${approval.id}/decision`, { decision: 'approve' }));
  const paid = ok(await manager.post(`/api/expenses/${expense.id}/pay`));
  assert.equal(paid.status, 'paid');
  const cash = ok(await cashier.get(`/api/cash?branchId=${branchId}`));
  assert.ok(cash.current.movements.some(m => m.kind === 'expense' && m.amount === -460000));
});

test('payouts net refund reversals against tips and clear both liabilities', async () => {
  const before = ok(await accountant.get(`/api/earnings/${rezaWorker.id}`));
  assert.ok(before.unpaidTotal > 0);
  fail(await reza.post(`/api/earnings/${rezaWorker.id}/payout`, { method: 'cash' }), 403, 'PERMISSION_DENIED');
  const after = ok(await accountant.post(`/api/earnings/${rezaWorker.id}/payout`, { method: 'cash' }));
  assert.equal(after.unpaidTotal, 0);
  assert.equal(after.payouts[0].amount, before.unpaidTotal);
  fail(await accountant.post(`/api/earnings/${rezaWorker.id}/payout`, { method: 'cash' }), 422, 'NOTHING_TO_PAY');
  assert.equal(ok(await accountant.get('/api/reports/trial-balance')).balanced, true);
});

test('inventory: stock is derived from movements and never negative', async () => {
  const items = ok(await manager.get('/api/inventory'));
  const tyre = items.find(i => i.name === 'Tyre cleaner');
  assert.equal(tyre.stock, 3);
  assert.equal(tyre.low, true);
  fail(await manager.post(`/api/inventory/${tyre.id}/movements`, { kind: 'usage', quantity: 4, reason: 'Wash' }), 422, 'INSUFFICIENT_STOCK');
  const after = ok(await manager.post(`/api/inventory/${tyre.id}/movements`, { kind: 'purchase', quantity: 10, unitCost: 150000, reason: 'Restock' }));
  assert.equal(after.stock, 13);
  assert.equal(after.low, false);
  fail(await cashier.post(`/api/inventory/${tyre.id}/movements`, { kind: 'usage', quantity: 1, reason: 'x' }), 403, 'PERMISSION_DENIED');
});

test('reports: summary, scorecard and xlsx/csv exports', async () => {
  const summary = ok(await owner.get('/api/reports/summary'));
  assert.ok(summary.metrics.revenue >= 500000);
  assert.ok(summary.score.factors.length > 0);
  const xlsx = await owner.get('/api/reports/export?kind=all&format=xlsx');
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  const csv = await owner.get('/api/reports/export?kind=jobs&format=csv');
  assert.equal(csv.body.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.match(csv.body.toString('utf8'), /ایران/);
  fail(await cashier.get('/api/reports/summary'), 403, 'PERMISSION_DENIED');
});

test('audit trail and ledger are append-only at the database level', () => {
  assert.throws(() => env.db.run('UPDATE audit_events SET action = :a', { a: 'tampered' }), /immutable/);
  assert.throws(() => env.db.run('DELETE FROM ledger_entries'), /append-only/);
  assert.ok(env.db.get('SELECT count(*) AS n FROM audit_events').n > 20);
});

test('logout revokes the session server-side', async () => {
  const c = await signedIn(env.base, 'quality@shinepro.local');
  ok(await c.post('/api/auth/logout'));
  fail(await c.get('/api/me'), 401, 'AUTHENTICATION_REQUIRED');
  fail(await client(env.base).get('/api/jobs'), 401, 'AUTHENTICATION_REQUIRED');
});
