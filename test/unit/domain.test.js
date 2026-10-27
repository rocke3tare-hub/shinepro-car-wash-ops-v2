import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBasisPoints, parseToman, parseBasisPoints } from '../../src/lib/money.js';
import { quote, commissionFor, assertPoolLimit, loyaltyPoints } from '../../src/domain/pricing.js';
import { nextStatus, guard, JOB_ACTIONS } from '../../src/domain/jobs.js';
import { preparePayment, splitTip } from '../../src/domain/payments.js';
import { paymentEntries, refundEntries, balanced, cashDifferenceEntries, payoutEntries } from '../../src/domain/ledger.js';
import { expectedCash, signedAmount } from '../../src/domain/cash.js';
import { buildScope, can, canAccessBranch } from '../../src/domain/permissions.js';
import { weighted, workerScore } from '../../src/domain/scoring.js';
import { isoDate } from '../../src/lib/validate.js';

const code = expected => error => error.code === expected;

test('money: half-up basis point rounding with integer arithmetic', () => {
  assert.equal(applyBasisPoints(500000, 1000), 50000);
  assert.equal(applyBasisPoints(5, 5000), 3); // 2.5 -> 3
  assert.equal(applyBasisPoints(5, 4999), 2);
  assert.equal(applyBasisPoints(999_999_999_999, 1), 100000000); // 99,999,999.9999 -> 100,000,000
});

test('money: parsing rejects decimals, negatives and junk', () => {
  assert.equal(parseToman('250000'), 250000);
  assert.equal(parseToman(0), 0);
  for (const bad of ['12.5', '-1', '1e5', '', ' ', 'abc', null, '1234567890123456']) {
    assert.throws(() => parseToman(bad), code('VALIDATION_ERROR'), String(bad));
  }
  assert.throws(() => parseToman(0, 'x', { allowZero: false }), code('VALIDATION_ERROR'));
  assert.throws(() => parseBasisPoints('10001'), code('VALIDATION_ERROR'));
});

test('dates: impossible calendar dates are rejected', () => {
  assert.equal(isoDate('2026-02-28', 'd'), '2026-02-28');
  assert.throws(() => isoDate('2026-02-30', 'd'), code('VALIDATION_ERROR'));
});

test('pricing: missing vehicle price is rejected instead of becoming 0', () => {
  assert.throws(() => quote(undefined, 0, 1000), code('SERVICE_NOT_OFFERED'));
});

test('pricing: discount bounds and approval threshold', () => {
  const q = quote({ amount: 550000 }, 50000, 1000);
  assert.deepEqual([q.originalPrice, q.finalPrice, q.discountNeedsApproval], [550000, 500000, false]);
  assert.equal(quote({ amount: 550000 }, 55001, 1000).discountNeedsApproval, true);
  assert.equal(quote({ amount: 550000 }, 55000, 1000).discountNeedsApproval, false);
  assert.throws(() => quote({ amount: 550000 }, 550001, 1000), code('VALIDATION_ERROR'));
});

test('commission: percentage and fixed both count toward the pool limit', () => {
  const rows = [
    { commission_type: 'percentage', basis_points: 1000, fixed_amount: 0 },
    { commission_type: 'percentage', basis_points: 1000, fixed_amount: 0 },
    { commission_type: 'percentage', basis_points: 700, fixed_amount: 0 },
    { commission_type: 'percentage', basis_points: 500, fixed_amount: 0 }
  ];
  assert.equal(assertPoolLimit(500000, rows, 3200).total, 160000);
  assert.throws(() => assertPoolLimit(500000, [...rows, { commission_type: 'fixed', basis_points: 0, fixed_amount: 1 }], 3200), code('COMMISSION_LIMIT_EXCEEDED'));
  assert.equal(commissionFor(475000, { commission_type: 'percentage', basis_points: 2000 }), 95000);
});

test('loyalty: whole points only', () => {
  assert.equal(loyaltyPoints(29999, 10000), 2);
  assert.equal(loyaltyPoints(5000, 0), 0);
});

test('jobs: transitions are explicit; payment is not a job action', () => {
  assert.equal(nextStatus({ status: 'assigned' }, 'start'), 'in_progress');
  assert.equal(nextStatus({ status: 'rework_required' }, 'start'), 'in_progress');
  assert.throws(() => nextStatus({ status: 'waiting' }, 'approve_quality'), code('INVALID_STATUS_TRANSITION'));
  assert.throws(() => nextStatus({ status: 'completed' }, 'cancel'), code('INVALID_STATUS_TRANSITION'));
  assert.equal(JOB_ACTIONS.complete, undefined);
});

test('jobs: guards block self-approval, unassigned start and paid cancellation', () => {
  const assignments = [{ worker_id: 'w1', status: 'completed' }];
  assert.match(guard({}, 'approve_quality', { assignments, actorWorkerId: 'w1' }), /cannot approve/);
  assert.equal(guard({}, 'approve_quality', { assignments, actorWorkerId: 'w2' }), null);
  assert.match(guard({}, 'approve_quality', { assignments, checklistComplete: false }), /checklist/);
  assert.match(guard({}, 'start', { assignments: [] }), /Assign/);
  assert.match(guard({ payment_status: 'paid' }, 'cancel'), /refund/);
});

test('payments: only at ready_for_payment, exact amount, tips separate', () => {
  const job = { status: 'ready_for_payment', payment_status: 'unpaid', discount_status: 'none', final_price: 500000 };
  const ok = preparePayment(job, { parts: [{ method: 'cash', amount: 200000 }, { method: 'card', amount: '300000' }], tipAmount: 20000, tipMethod: 'cash' });
  assert.equal(ok.amount, 500000);
  assert.equal(ok.tipAmount, 20000);
  assert.throws(() => preparePayment({ ...job, status: 'cancelled' }, { parts: [{ method: 'cash', amount: 500000 }] }), code('JOB_NOT_READY_FOR_PAYMENT'));
  assert.throws(() => preparePayment({ ...job, discount_status: 'pending' }, { parts: [{ method: 'cash', amount: 500000 }] }), code('DISCOUNT_PENDING'));
  assert.throws(() => preparePayment(job, { parts: [{ method: 'cash', amount: 499999 }] }), code('INSUFFICIENT_PAYMENT'));
  assert.throws(() => preparePayment(job, { parts: [{ method: 'cash', amount: 500001 }] }), code('OVERPAYMENT_NOT_ALLOWED'));
  assert.throws(() => preparePayment(job, { parts: [{ method: 'cash', amount: 250000 }, { method: 'cash', amount: 250000 }] }), code('VALIDATION_ERROR'));
  assert.throws(() => preparePayment(job, { parts: [{ method: 'bitcoin', amount: 500000 }] }), code('VALIDATION_ERROR'));
  assert.throws(() => preparePayment(job, { parts: [{ method: 'cash', amount: 500000 }], tipAmount: 10, tipMethod: 'customer_credit' }), code('VALIDATION_ERROR'));
});

test('payments: tip split keeps every toman', () => {
  const split = splitTip(10001, ['a', 'b', 'c']);
  assert.deepEqual(split, [{ workerId: 'a', amount: 3335 }, { workerId: 'b', amount: 3333 }, { workerId: 'c', amount: 3333 }]);
  assert.equal(split.reduce((s, r) => s + r.amount, 0), 10001);
  assert.deepEqual(splitTip(2, ['a', 'b', 'c']), [{ workerId: 'a', amount: 2 }]);
});

test('ledger: payments post tips to a liability and always balance', () => {
  const lines = paymentEntries({ parts: [{ method: 'cash', amount: 200000 }, { method: 'card', amount: 300000 }], finalPrice: 500000, tipAmount: 20000, tipMethod: 'cash' });
  const cash = lines.find(l => l.account === 'cash_on_hand');
  assert.equal(cash.debit, 220000);
  assert.equal(lines.find(l => l.account === 'tips_payable').credit, 20000);
  assert.equal(lines.find(l => l.account === 'service_revenue').credit, 500000);
  assert.throws(() => balanced([{ account: 'bank', debit: 1, credit: 0 }]), code('LEDGER_UNBALANCED'));
  assert.equal(refundEntries({ amount: 100, method: 'cash', commissionReversal: 10 }).length, 4);
  assert.deepEqual(cashDifferenceEntries(0), []);
  assert.equal(cashDifferenceEntries(-500).find(l => l.account === 'cash_over_short').debit, 500);
  assert.equal(payoutEntries({ commission: 0, tips: 50, method: 'cash' }).length, 2);
});

test('cash: expected cash derives from signed movements', () => {
  const movements = [
    { kind: 'payment', amount: signedAmount('payment', 6000000) },
    { kind: 'expense', amount: signedAmount('expense', 500000) },
    { kind: 'removed', amount: signedAmount('removed', 3000000) },
    { kind: 'refund', amount: signedAmount('refund', 200000) }
  ];
  assert.equal(expectedCash(2000000, movements), 4300000);
});

test('permissions: branch scope and business-wide roles', () => {
  const manager = buildScope([{ role: 'branch_manager', branch_id: 'br-a' }]);
  assert.equal(canAccessBranch(manager, 'br-a'), true);
  assert.equal(canAccessBranch(manager, 'br-b'), false);
  assert.equal(can(manager, 'payments.create'), true);
  assert.equal(can(manager, 'approvals.refund'), false);
  const accountant = buildScope([{ role: 'accountant', branch_id: 'br-a' }]);
  assert.equal(canAccessBranch(accountant, 'br-z'), true);
  const customer = buildScope([{ role: 'customer', branch_id: null }]);
  assert.equal(can(customer, 'jobs.view'), false);
  assert.equal(can(customer, 'portal.self'), true);
});

test('scoring: missing data is excluded, not invented', () => {
  const result = weighted([{ name: 'a', weight: 50, score: 80 }, { name: 'b', weight: 50, score: null }]);
  assert.equal(result.score, 80);
  assert.equal(result.completeness, 50);
  assert.equal(weighted([{ name: 'a', weight: 1, score: null }]).score, null);
  assert.equal(workerScore({ reviewed: 0, assigned: 0, onShift: false }).score, 0);
});

test('reports: business-day windows follow the branch time zone', async () => {
  const { zonedMidnight, localDate } = await import('../../src/services/reports.js');
  assert.equal(new Date(zonedMidnight('2026-10-27', 'Asia/Tehran')).toISOString(), '2026-10-26T20:30:00.000Z');
  assert.equal(new Date(zonedMidnight('2026-03-29', 'Europe/London')).toISOString(), '2026-03-29T00:00:00.000Z');
  assert.equal(new Date(zonedMidnight('2026-03-30', 'Europe/London')).toISOString(), '2026-03-29T23:00:00.000Z');
  assert.equal(localDate('Asia/Tehran', Date.parse('2026-10-26T21:00:00Z')), '2026-10-27');
});
