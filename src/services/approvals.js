import { newId, parseJson } from '../db/database.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { text, oneOf } from '../lib/validate.js';
import { can } from '../domain/permissions.js';
import { refundEntries } from '../domain/ledger.js';
import { signedAmount } from '../domain/cash.js';
import { audit, branchFilter, postLedger, recordCashMovement, requireBranch, requireOpenCashSession, requireAnyPermission } from './common.js';

const PERMISSION_FOR = { discount: 'approvals.discount', refund: 'approvals.refund', expense: 'approvals.expense', cash_difference: 'approvals.cash' };

function decidableKinds(actor) {
  return Object.entries(PERMISSION_FOR).filter(([, permission]) => can(actor, permission)).map(([kind]) => kind);
}

export function listApprovals(ctx, { status = 'pending' } = {}) {
  requireAnyPermission(ctx, Object.values(PERMISSION_FOR));
  const kinds = decidableKinds(ctx.actor);
  const scope = branchFilter(ctx, 'a.branch_id');
  const params = { business: ctx.actor.businessId, ...scope.params };
  const kindNames = kinds.map((kind, i) => { params[`kind_${i}`] = kind; return `:kind_${i}`; });
  params.status = oneOf(status, ['pending', 'approved', 'rejected', 'withdrawn', 'all'], 'Status');
  const rows = ctx.db.all(`SELECT a.*, u.display_name AS requested_by_name, d.display_name AS decided_by_name FROM approvals a
    JOIN users u ON u.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
    WHERE a.business_id = :business AND (a.branch_id IS NULL OR ${scope.sql}) AND a.kind IN (${kindNames.join(', ')})
      AND (:status = 'all' OR a.status = :status)
    ORDER BY a.created_at DESC LIMIT 200`, params);
  return rows.map(row => ({
    id: row.id, kind: row.kind, subjectType: row.subject_type, subjectId: row.subject_id, branchId: row.branch_id, amount: row.amount, reason: row.reason,
    payload: parseJson(row.payload, {}), status: row.status, requestedBy: row.requested_by_name, decidedBy: row.decided_by_name,
    decisionNote: row.decision_note, createdAt: row.created_at, decidedAt: row.decided_at,
    selfRequested: row.requested_by === ctx.actor.userId
  }));
}

/** Approve or reject. Four-eyes: the requester can never decide their own request. */
export function decideApproval(ctx, approvalId, input) {
  const approval = ctx.db.get('SELECT * FROM approvals WHERE id = :id AND business_id = :business', { id: approvalId, business: ctx.actor.businessId });
  if (!approval) throw notFound('Approval');
  if (!can(ctx.actor, PERMISSION_FOR[approval.kind])) throw forbidden();
  if (approval.branch_id) requireBranch(ctx, approval.branch_id);
  if (approval.status !== 'pending') throw new AppError('ALREADY_DECIDED', 'This request has already been decided.', 409);
  if (approval.requested_by === ctx.actor.userId) throw new AppError('SELF_APPROVAL_DENIED', 'You cannot decide a request you raised yourself.', 403);
  const decision = oneOf(input.decision, ['approve', 'reject'], 'Decision');
  const note = text(input.note, 'Decision note', { required: decision === 'reject', max: 300 });
  const approved = decision === 'approve';

  ctx.db.run(`UPDATE approvals SET status = :status, decided_by = :user, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note = :note WHERE id = :id`,
    { id: approvalId, status: approved ? 'approved' : 'rejected', user: ctx.actor.userId, note });

  if (approval.kind === 'discount') applyDiscountDecision(ctx, approval, approved);
  if (approval.kind === 'refund') applyRefundDecision(ctx, approval, approved);
  if (approval.kind === 'expense') {
    ctx.db.run(`UPDATE expenses SET status = :status WHERE id = :id AND status = 'submitted'`, { id: approval.subject_id, status: approved ? 'approved' : 'rejected' });
  }
  if (approval.kind === 'cash_difference') {
    ctx.db.run(`UPDATE cash_sessions SET status = 'reviewed', reviewed_by = :user, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id AND status = 'review_required'`, { id: approval.subject_id, user: ctx.actor.userId });
  }
  audit(ctx, { action: `approval.${approved ? 'approved' : 'rejected'}`, entityType: approval.subject_type, entityId: approval.subject_id, branchId: approval.branch_id, after: { kind: approval.kind, amount: approval.amount }, reason: note });
  return listApprovals(ctx, { status: 'all' }).find(a => a.id === approvalId);
}

function applyDiscountDecision(ctx, approval, approved) {
  const job = ctx.db.get('SELECT * FROM jobs WHERE id = :id', { id: approval.subject_id });
  if (!job || job.payment_status !== 'unpaid' || job.discount_status !== 'pending') return;
  if (approved) {
    ctx.db.run(`UPDATE jobs SET discount_status = 'approved', version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: job.id });
  } else {
    // Rejected discount reverts to the full price; commission base follows.
    ctx.db.run(`UPDATE jobs SET discount = 0, discount_status = 'rejected', final_price = original_price, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: job.id });
  }
  audit(ctx, { action: approved ? 'job.discount_approved' : 'job.discount_rejected', entityType: 'job', entityId: job.id, branchId: job.branch_id, before: { discount: job.discount, finalPrice: job.final_price }, after: approved ? { discount: job.discount } : { discount: 0, finalPrice: job.original_price } });
}

function applyRefundDecision(ctx, approval, approved) {
  const payload = parseJson(approval.payload, {});
  const refund = ctx.db.get(`SELECT * FROM refunds WHERE id = :id AND status = 'pending'`, { id: payload.refundId });
  if (!refund) throw new AppError('REFUND_NOT_PENDING', 'The refund request is no longer pending.', 409);
  ctx.db.run('UPDATE refunds SET status = :status WHERE id = :id', { id: refund.id, status: approved ? 'approved' : 'rejected' });
  if (!approved) return;

  const job = ctx.db.get('SELECT * FROM jobs WHERE id = :id', { id: refund.job_id });
  const payment = ctx.db.get('SELECT * FROM payments WHERE id = :id', { id: refund.payment_id });
  const refundedTotal = ctx.db.get(`SELECT COALESCE(sum(amount), 0) AS total FROM refunds WHERE payment_id = :id AND status = 'approved'`, { id: payment.id }).total;
  if (refundedTotal > payment.amount) throw new AppError('REFUND_EXCEEDS_PAYMENT', 'Refunds would exceed the amount paid.', 422);
  const full = refundedTotal === payment.amount;

  // A full refund reverses the job's commissions with negative adjustments
  // (earnings already paid out are recovered from the next payout).
  let commissionReversal = 0;
  if (full) {
    const commissions = ctx.db.all(`SELECT worker_id, assignment_id, sum(amount) AS amount FROM worker_earnings WHERE job_id = :job AND kind IN ('commission','adjustment') GROUP BY worker_id, assignment_id HAVING sum(amount) > 0`, { job: job.id });
    for (const row of commissions) {
      commissionReversal += row.amount;
      ctx.db.run(`INSERT INTO worker_earnings(id, business_id, branch_id, worker_id, job_id, assignment_id, kind, amount, note) VALUES (:id, :business, :branch, :worker, :job, :assignment, 'adjustment', :amount, :note)`,
        { id: newId(), business: job.business_id, branch: job.branch_id, worker: row.worker_id, job: job.id, assignment: row.assignment_id, amount: -row.amount, note: `${job.code} · refund reversal` });
    }
    ctx.db.run(`UPDATE job_assignments SET status = 'reversed' WHERE job_id = :job AND status = 'earned'`, { job: job.id });
    ctx.db.run(`UPDATE payments SET status = 'refunded' WHERE id = :id`, { id: payment.id });
    ctx.db.run(`UPDATE jobs SET status = 'refunded', payment_status = 'refunded', version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: job.id });
    const points = ctx.db.get(`SELECT COALESCE(sum(points), 0) AS points FROM loyalty_transactions WHERE job_id = :job`, { job: job.id }).points;
    if (points > 0) ctx.db.run(`INSERT INTO loyalty_transactions(id, business_id, customer_id, job_id, points, reason) VALUES (:id, :business, :customer, :job, :points, 'refund_reversal')`,
      { id: newId(), business: job.business_id, customer: job.customer_id, job: job.id, points: -points });
  }
  if (refund.method === 'cash') {
    const session = requireOpenCashSession(ctx, job.branch_id);
    recordCashMovement(ctx, { sessionId: session.id, kind: 'refund', amount: signedAmount('refund', refund.amount), referenceType: 'refund', referenceId: refund.id, note: job.code });
  }
  postLedger(ctx, { branchId: job.branch_id, eventType: 'refund', sourceType: 'refund', sourceId: refund.id, idempotencyKey: `refund:${refund.id}`, memo: job.code,
    entries: refundEntries({ amount: refund.amount, method: refund.method, commissionReversal }) });
}
