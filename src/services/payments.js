import crypto from 'node:crypto';
import { newId } from '../db/database.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { parseToman } from '../lib/money.js';
import { text, oneOf } from '../lib/validate.js';
import { preparePayment, splitTip, canonicalPaymentRequest, PAYMENT_METHODS } from '../domain/payments.js';
import { commissionFor, loyaltyPoints } from '../domain/pricing.js';
import { paymentEntries, commissionEarnedEntries } from '../domain/ledger.js';
import { signedAmount } from '../domain/cash.js';
import { audit, postLedger, recordCashMovement, requireOpenCashSession, requirePermission, settings } from './common.js';
import { loadJob, getJob } from './jobs.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function creditAvailable(db, customerId) {
  const customer = db.get('SELECT credit_limit FROM customers WHERE id = :id', { id: customerId });
  const used = db.get(`SELECT COALESCE(sum(pp.amount), 0) AS used FROM payment_parts pp JOIN payments p ON p.id = pp.payment_id JOIN jobs j ON j.id = p.job_id
    WHERE j.customer_id = :id AND pp.method = 'customer_credit' AND p.status = 'confirmed'`, { id: customerId }).used;
  return (customer?.credit_limit ?? 0) - used;
}

/**
 * Take the customer payment for a job. Atomically: payment + parts, job
 * completion, commission and tip earnings, ledger postings, cash movements,
 * loyalty points and audit. Safe to retry with the same Idempotency-Key.
 */
export function takePayment(ctx, jobId, input, idempotencyKey) {
  requirePermission(ctx, 'payments.create');
  const key = text(idempotencyKey, 'Idempotency-Key', { required: true, max: 100 });
  const job = loadJob(ctx, jobId);

  const existing = ctx.db.get('SELECT * FROM payments WHERE business_id = :business AND idempotency_key = :key', { business: ctx.actor.businessId, key });
  if (existing) {
    // Same key, same request = safe retry. Same key, different request = client bug.
    let hash = null;
    try { hash = sha256(canonicalPaymentRequest(jobId, preparePayment({ ...job, status: 'ready_for_payment', payment_status: 'unpaid', discount_status: 'none' }, input))); } catch { hash = null; }
    if (existing.job_id !== jobId || hash !== existing.request_hash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different payment.', 409);
    return { duplicate: true, job: getJob(ctx, jobId) };
  }

  const prepared = preparePayment(job, input);
  const credit = prepared.parts.find(p => p.method === 'customer_credit');
  if (credit) {
    if (!job.customer_id) throw new AppError('CREDIT_NOT_AVAILABLE', 'Customer credit needs a registered customer on the job.', 422);
    const available = creditAvailable(ctx.db, job.customer_id);
    if (credit.amount > available) throw new AppError('CREDIT_LIMIT_EXCEEDED', `Customer credit available is ${Math.max(0, available).toLocaleString('en-US')} toman.`, 422);
  }
  const cashIn = (prepared.parts.find(p => p.method === 'cash')?.amount ?? 0);
  const cashTip = prepared.tipMethod === 'cash' ? prepared.tipAmount : 0;
  const cashSession = cashIn || cashTip ? requireOpenCashSession(ctx, job.branch_id) : null;

  const paymentId = newId();
  ctx.db.run(`INSERT INTO payments(id, business_id, branch_id, job_id, amount, tip_amount, tip_method, idempotency_key, request_hash, created_by)
    VALUES (:id, :business, :branch, :job, :amount, :tip, :tipMethod, :key, :hash, :user)`, {
    id: paymentId, business: ctx.actor.businessId, branch: job.branch_id, job: jobId, amount: prepared.amount, tip: prepared.tipAmount,
    tipMethod: prepared.tipMethod, key, hash: sha256(canonicalPaymentRequest(jobId, prepared)), user: ctx.actor.userId
  });
  for (const part of prepared.parts) {
    ctx.db.run('INSERT INTO payment_parts(id, payment_id, method, amount, reference) VALUES (:id, :payment, :method, :amount, :reference)', { id: newId(), payment: paymentId, ...part });
  }

  ctx.db.run(`UPDATE jobs SET status = 'completed', payment_status = 'paid', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: jobId });

  // Commissions become earned only now: after quality approval AND payment.
  const assignments = ctx.db.all(`SELECT * FROM job_assignments WHERE job_id = :job AND status = 'approved'`, { job: jobId });
  let commissionTotal = 0;
  for (const assignment of assignments) {
    const amount = commissionFor(job.final_price, assignment);
    commissionTotal += amount;
    ctx.db.run(`UPDATE job_assignments SET status = 'earned' WHERE id = :id`, { id: assignment.id });
    if (amount > 0) {
      ctx.db.run(`INSERT INTO worker_earnings(id, business_id, branch_id, worker_id, job_id, assignment_id, kind, amount, note) VALUES (:id, :business, :branch, :worker, :job, :assignment, 'commission', :amount, :note)`,
        { id: newId(), business: ctx.actor.businessId, branch: job.branch_id, worker: assignment.worker_id, job: jobId, assignment: assignment.id, amount, note: `${job.code} · ${assignment.role_label}` });
    }
  }
  for (const share of splitTip(prepared.tipAmount, assignments.map(a => a.worker_id))) {
    ctx.db.run(`INSERT INTO worker_earnings(id, business_id, branch_id, worker_id, job_id, kind, amount, note) VALUES (:id, :business, :branch, :worker, :job, 'tip', :amount, :note)`,
      { id: newId(), business: ctx.actor.businessId, branch: job.branch_id, worker: share.workerId, job: jobId, amount: share.amount, note: `${job.code} · tip` });
  }

  postLedger(ctx, { branchId: job.branch_id, eventType: 'customer_payment', sourceType: 'payment', sourceId: paymentId, idempotencyKey: `payment:${paymentId}`, memo: job.code,
    entries: paymentEntries({ parts: prepared.parts, finalPrice: job.final_price, tipAmount: prepared.tipAmount, tipMethod: prepared.tipMethod }) });
  postLedger(ctx, { branchId: job.branch_id, eventType: 'commission_earned', sourceType: 'job', sourceId: jobId, idempotencyKey: `commission:${jobId}`, memo: job.code, entries: commissionEarnedEntries(commissionTotal) });

  if (cashSession && cashIn) recordCashMovement(ctx, { sessionId: cashSession.id, kind: 'payment', amount: signedAmount('payment', cashIn), referenceType: 'payment', referenceId: paymentId, note: job.code });
  if (cashSession && cashTip) recordCashMovement(ctx, { sessionId: cashSession.id, kind: 'tip', amount: signedAmount('tip', cashTip), referenceType: 'payment', referenceId: paymentId, note: `${job.code} tip` });

  if (job.customer_id) {
    const points = loyaltyPoints(job.final_price, settings(ctx).loyaltyTomanPerPoint);
    if (points > 0) ctx.db.run(`INSERT INTO loyalty_transactions(id, business_id, customer_id, job_id, points, reason) VALUES (:id, :business, :customer, :job, :points, 'earned')`,
      { id: newId(), business: ctx.actor.businessId, customer: job.customer_id, job: jobId, points });
  }

  audit(ctx, { action: 'payment.confirmed', entityType: 'job', entityId: jobId, branchId: job.branch_id, before: { status: job.status, paymentStatus: 'unpaid' },
    after: { status: 'completed', paymentId, amount: prepared.amount, tip: prepared.tipAmount, parts: prepared.parts.map(p => `${p.method}:${p.amount}`), commissionTotal } });
  return { duplicate: false, job: getJob(ctx, jobId) };
}

/** Ask for a refund; money moves only after a different authorised person approves it. */
export function requestRefund(ctx, jobId, input) {
  requirePermission(ctx, 'refunds.request');
  const job = loadJob(ctx, jobId);
  if (job.payment_status !== 'paid') throw new AppError('NOT_REFUNDABLE', 'Only paid jobs can be refunded.', 422);
  const payment = ctx.db.get(`SELECT * FROM payments WHERE job_id = :job AND status = 'confirmed'`, { job: jobId });
  if (!payment) throw notFound('Payment');
  if (ctx.db.get(`SELECT 1 FROM refunds WHERE job_id = :job AND status = 'pending'`, { job: jobId })) throw new AppError('REFUND_PENDING', 'A refund for this job is already waiting for approval.', 409);
  const refunded = ctx.db.get(`SELECT COALESCE(sum(amount), 0) AS total FROM refunds WHERE job_id = :job AND status = 'approved'`, { job: jobId }).total;
  const amount = parseToman(input.amount, 'Refund amount', { allowZero: false });
  if (amount > payment.amount - refunded) throw invalid(`At most ${(payment.amount - refunded).toLocaleString('en-US')} toman can still be refunded.`);
  const method = oneOf(input.method || 'cash', PAYMENT_METHODS, 'Refund method');
  if (method === 'customer_credit' && !ctx.db.get(`SELECT 1 FROM payment_parts WHERE payment_id = :id AND method = 'customer_credit'`, { id: payment.id })) throw invalid('Refund to customer credit only when the job was paid with credit.');
  const reason = text(input.reason, 'Refund reason', { required: true, max: 300 });
  const refundId = newId();
  ctx.db.run('INSERT INTO refunds(id, payment_id, job_id, amount, method, reason, requested_by) VALUES (:id, :payment, :job, :amount, :method, :reason, :user)',
    { id: refundId, payment: payment.id, job: jobId, amount, method, reason, user: ctx.actor.userId });
  ctx.db.run(`INSERT INTO approvals(id, business_id, branch_id, kind, subject_type, subject_id, amount, reason, payload, requested_by)
    VALUES (:id, :business, :branch, 'refund', 'job', :job, :amount, :reason, :payload, :user)`, {
    id: newId(), business: ctx.actor.businessId, branch: job.branch_id, job: jobId, amount, reason, payload: JSON.stringify({ refundId, code: job.code, method, full: amount === payment.amount - refunded && refunded === 0 }), user: ctx.actor.userId
  });
  audit(ctx, { action: 'refund.requested', entityType: 'job', entityId: jobId, branchId: job.branch_id, after: { amount, method }, reason });
  return getJob(ctx, jobId);
}
