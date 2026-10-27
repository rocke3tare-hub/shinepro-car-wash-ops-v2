import { newId } from '../db/database.js';
import { AppError, notFound } from '../lib/errors.js';
import { parseToman } from '../lib/money.js';
import { text, id as idField } from '../lib/validate.js';
import { signedAmount, summarize, needsReview, MOVEMENT_LABELS } from '../domain/cash.js';
import { cashAddedEntries, cashRemovedEntries, cashDifferenceEntries } from '../domain/ledger.js';
import { audit, openCashSession, postLedger, recordCashMovement, requireBranch, requireOpenCashSession, requirePermission, settings } from './common.js';

function branchOf(ctx, branchId) {
  const id = idField(branchId, 'Branch');
  const branch = ctx.db.get('SELECT * FROM branches WHERE id = :id AND business_id = :business', { id, business: ctx.actor.businessId });
  if (!branch) throw notFound('Branch');
  requireBranch(ctx, id);
  return branch;
}

function present(db, session) {
  if (!session) return null;
  const movements = db.all(`SELECT m.*, u.display_name AS created_by_name FROM cash_movements m JOIN users u ON u.id = m.created_by WHERE m.cash_session_id = :id ORDER BY m.created_at`, { id: session.id });
  const summary = summarize(session.opening_cash, movements);
  return {
    id: session.id, branchId: session.branch_id, status: session.status, openingCash: session.opening_cash, openedAt: session.opened_at,
    expectedCash: session.status === 'open' ? summary.expected : session.expected_cash,
    countedCash: session.counted_cash, difference: session.difference, explanation: session.explanation, closedAt: session.closed_at,
    totals: summary.byKind,
    movements: movements.map(m => ({ id: m.id, kind: m.kind, label: MOVEMENT_LABELS[m.kind], amount: m.amount, note: m.note, createdBy: m.created_by_name, createdAt: m.created_at }))
  };
}

export function cashOverview(ctx, branchId) {
  requirePermission(ctx, 'cash.operate');
  const branch = branchOf(ctx, branchId);
  const current = openCashSession(ctx, branch.id);
  const recent = ctx.db.all(`SELECT * FROM cash_sessions WHERE branch_id = :branch AND status <> 'open' ORDER BY opened_at DESC LIMIT 10`, { branch: branch.id });
  return { branch: { id: branch.id, name: branch.name }, current: present(ctx.db, current), recent: recent.map(row => present(ctx.db, row)), reviewThreshold: settings(ctx).cashReviewThreshold };
}

export function openRegister(ctx, branchId, input) {
  requirePermission(ctx, 'cash.operate');
  const branch = branchOf(ctx, branchId);
  if (openCashSession(ctx, branch.id)) throw new AppError('REGISTER_ALREADY_OPEN', 'The register for this branch is already open.', 409);
  const openingCash = parseToman(input.openingCash, 'Opening cash');
  const id = newId();
  ctx.db.run('INSERT INTO cash_sessions(id, business_id, branch_id, opening_cash, opened_by) VALUES (:id, :business, :branch, :opening, :user)', { id, business: ctx.actor.businessId, branch: branch.id, opening: openingCash, user: ctx.actor.userId });
  audit(ctx, { action: 'cash.opened', entityType: 'cash_session', entityId: id, branchId: branch.id, after: { openingCash } });
  return cashOverview(ctx, branch.id);
}

export function moveCash(ctx, branchId, input) {
  requirePermission(ctx, 'cash.operate');
  const branch = branchOf(ctx, branchId);
  const session = requireOpenCashSession(ctx, branch.id);
  const kind = input.kind === 'removed' ? 'removed' : input.kind === 'added' ? 'added' : null;
  if (!kind) throw new AppError('VALIDATION_ERROR', 'Choose whether cash is being added or removed.', 422);
  const amount = parseToman(input.amount, 'Amount', { allowZero: false });
  const note = text(input.note, 'Reason', { required: true, max: 200 });
  if (kind === 'removed') {
    const expected = summarize(session.opening_cash, ctx.db.all('SELECT kind, amount FROM cash_movements WHERE cash_session_id = :id', { id: session.id })).expected;
    if (amount > expected) throw new AppError('INSUFFICIENT_CASH', `The drawer should only hold ${expected.toLocaleString('en-US')} toman.`, 422);
  }
  const movementId = newId();
  recordCashMovement(ctx, { sessionId: session.id, kind, amount: signedAmount(kind, amount), referenceType: 'cash_session', referenceId: session.id, note });
  postLedger(ctx, { branchId: branch.id, eventType: kind === 'added' ? 'cash_added' : 'cash_removed', sourceType: 'cash_session', sourceId: session.id, idempotencyKey: `cash:${movementId}`, memo: note,
    entries: kind === 'added' ? cashAddedEntries(amount) : cashRemovedEntries(amount) });
  audit(ctx, { action: `cash.${kind}`, entityType: 'cash_session', entityId: session.id, branchId: branch.id, after: { amount }, reason: note });
  return cashOverview(ctx, branch.id);
}

/**
 * Close with a physical count. The difference is booked immediately (the books
 * must match the drawer); differences above the threshold also need review.
 */
export function closeRegister(ctx, branchId, input) {
  requirePermission(ctx, 'cash.operate');
  const branch = branchOf(ctx, branchId);
  const session = requireOpenCashSession(ctx, branch.id);
  const counted = parseToman(input.countedCash, 'Counted cash');
  const movements = ctx.db.all('SELECT kind, amount FROM cash_movements WHERE cash_session_id = :id', { id: session.id });
  const expected = summarize(session.opening_cash, movements).expected;
  const difference = counted - expected;
  const threshold = settings(ctx).cashReviewThreshold;
  const review = needsReview(difference, threshold);
  const explanation = text(input.explanation, 'Explanation', { required: difference !== 0, max: 500 });
  ctx.db.run(`UPDATE cash_sessions SET status = :status, counted_cash = :counted, expected_cash = :expected, difference = :difference, explanation = :explanation,
    closed_by = :user, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`,
    { id: session.id, status: review ? 'review_required' : 'closed', counted, expected, difference, explanation, user: ctx.actor.userId });
  postLedger(ctx, { branchId: branch.id, eventType: 'cash_difference', sourceType: 'cash_session', sourceId: session.id, idempotencyKey: `cash-diff:${session.id}`, memo: explanation, entries: cashDifferenceEntries(difference) });
  if (review) {
    ctx.db.run(`INSERT INTO approvals(id, business_id, branch_id, kind, subject_type, subject_id, amount, reason, payload, requested_by)
      VALUES (:id, :business, :branch, 'cash_difference', 'cash_session', :session, :amount, :reason, :payload, :user)`, {
      id: newId(), business: ctx.actor.businessId, branch: branch.id, session: session.id, amount: difference, reason: explanation,
      payload: JSON.stringify({ expected, counted, branch: branch.name }), user: ctx.actor.userId
    });
  }
  audit(ctx, { action: 'cash.closed', entityType: 'cash_session', entityId: session.id, branchId: branch.id, after: { expected, counted, difference, reviewRequired: review }, reason: explanation });
  return cashOverview(ctx, branch.id);
}
