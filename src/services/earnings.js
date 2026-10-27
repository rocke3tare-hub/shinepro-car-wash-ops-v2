import { newId } from '../db/database.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { oneOf } from '../lib/validate.js';
import { can } from '../domain/permissions.js';
import { payoutEntries } from '../domain/ledger.js';
import { signedAmount } from '../domain/cash.js';
import { workerScore } from '../domain/scoring.js';
import { audit, branchFilter, postLedger, recordCashMovement, requireBranch, requireOpenCashSession, requirePermission, requireAnyPermission } from './common.js';

function balances(db, workerId) {
  const row = db.get(`SELECT
      COALESCE(sum(CASE WHEN payout_id IS NULL AND kind IN ('commission','adjustment') THEN amount END), 0) AS unpaid_commission,
      COALESCE(sum(CASE WHEN payout_id IS NULL AND kind = 'tip' THEN amount END), 0) AS unpaid_tips,
      COALESCE(sum(CASE WHEN payout_id IS NOT NULL THEN amount END), 0) AS paid_total,
      COALESCE(sum(amount), 0) AS lifetime
    FROM worker_earnings WHERE worker_id = :worker`, { worker: workerId });
  return { unpaidCommission: row.unpaid_commission, unpaidTips: row.unpaid_tips, unpaidTotal: row.unpaid_commission + row.unpaid_tips, paidTotal: row.paid_total, lifetime: row.lifetime };
}

function performance(db, workerId, onShift) {
  const assigned = db.get(`SELECT count(DISTINCT a.job_id) AS n FROM job_assignments a JOIN jobs j ON j.id = a.job_id WHERE a.worker_id = :w AND a.status <> 'removed' AND j.status <> 'cancelled'`, { w: workerId }).n;
  const completed = db.get(`SELECT count(DISTINCT a.job_id) AS n FROM job_assignments a WHERE a.worker_id = :w AND a.status IN ('earned','reversed')`, { w: workerId }).n;
  const reviews = db.get(`SELECT count(*) AS reviewed,
      sum(CASE WHEN NOT EXISTS (SELECT 1 FROM quality_checks q2 WHERE q2.job_id = q.job_id AND q2.outcome = 'rework') AND q.outcome = 'passed' THEN 1 ELSE 0 END) AS passed
    FROM quality_checks q WHERE q.outcome = 'passed' AND q.job_id IN (SELECT job_id FROM job_assignments WHERE worker_id = :w AND status <> 'removed')`, { w: workerId });
  return workerScore({ reviewed: reviews.reviewed || 0, passed: reviews.passed || 0, assigned, completed, onShift: Boolean(onShift) });
}

export function listEarnings(ctx) {
  requireAnyPermission(ctx, ['earnings.view', 'earnings.view_own']);
  const own = !can(ctx.actor, 'earnings.view');
  const scope = branchFilter(ctx, 'w.branch_id');
  const params = { business: ctx.actor.businessId, ...scope.params };
  let sql = `SELECT w.* FROM workers w WHERE w.business_id = :business AND ${scope.sql}`;
  if (own) { params.worker = ctx.actor.workerId || ''; sql += ' AND w.id = :worker'; }
  return ctx.db.all(`${sql} ORDER BY w.name`, params).map(w => ({
    workerId: w.id, name: w.name, title: w.title, branchId: w.branch_id, onShift: Boolean(w.on_shift), status: w.status,
    ...balances(ctx.db, w.id), score: performance(ctx.db, w.id, w.on_shift)
  }));
}

export function workerStatement(ctx, workerId) {
  requireAnyPermission(ctx, ['earnings.view', 'earnings.view_own']);
  if (!can(ctx.actor, 'earnings.view') && workerId !== ctx.actor.workerId) throw forbidden();
  const worker = ctx.db.get('SELECT * FROM workers WHERE id = :id AND business_id = :business', { id: workerId, business: ctx.actor.businessId });
  if (!worker) throw notFound('Worker');
  requireBranch(ctx, worker.branch_id);
  const lines = ctx.db.all(`SELECT e.id, e.kind, e.amount, e.note, e.earned_at, e.payout_id, j.code FROM worker_earnings e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.worker_id = :w ORDER BY e.earned_at DESC LIMIT 300`, { w: workerId });
  const payouts = ctx.db.all('SELECT id, amount, method, created_at FROM payouts WHERE worker_id = :w ORDER BY created_at DESC LIMIT 50', { w: workerId });
  return { worker: { id: worker.id, name: worker.name, title: worker.title }, ...balances(ctx.db, workerId), lines, payouts };
}

/** Pay out everything currently unpaid for one worker (commission net of adjustments, plus tips). */
export function payWorker(ctx, workerId, input) {
  requirePermission(ctx, 'payouts.create');
  const worker = ctx.db.get('SELECT * FROM workers WHERE id = :id AND business_id = :business', { id: workerId, business: ctx.actor.businessId });
  if (!worker) throw notFound('Worker');
  requireBranch(ctx, worker.branch_id);
  const method = oneOf(input.method || 'cash', ['cash', 'bank_transfer'], 'Payout method');
  const due = balances(ctx.db, workerId);
  if (due.unpaidTotal <= 0) throw new AppError('NOTHING_TO_PAY', 'This worker has no positive unpaid balance.', 422);
  // Negative commission (after refund reversals) is netted against tips.
  const commission = due.unpaidCommission;
  const tips = due.unpaidTips;
  const payoutId = newId();
  ctx.db.run('INSERT INTO payouts(id, business_id, branch_id, worker_id, amount, method, created_by) VALUES (:id, :business, :branch, :worker, :amount, :method, :user)',
    { id: payoutId, business: ctx.actor.businessId, branch: worker.branch_id, worker: workerId, amount: due.unpaidTotal, method, user: ctx.actor.userId });
  ctx.db.run('UPDATE worker_earnings SET payout_id = :payout WHERE worker_id = :worker AND payout_id IS NULL', { payout: payoutId, worker: workerId });
  if (method === 'cash') {
    const session = requireOpenCashSession(ctx, worker.branch_id);
    recordCashMovement(ctx, { sessionId: session.id, kind: 'payout', amount: signedAmount('payout', due.unpaidTotal), referenceType: 'payout', referenceId: payoutId, note: worker.name });
  }
  postLedger(ctx, { branchId: worker.branch_id, eventType: 'worker_payout', sourceType: 'payout', sourceId: payoutId, idempotencyKey: `payout:${payoutId}`, memo: worker.name,
    entries: payoutEntries({ commission, tips, method }) });
  audit(ctx, { action: 'payout.created', entityType: 'worker', entityId: workerId, branchId: worker.branch_id, after: { amount: due.unpaidTotal, commission, tips, method } });
  return workerStatement(ctx, workerId);
}
