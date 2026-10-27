import { newId } from '../db/database.js';
import { AppError, notFound } from '../lib/errors.js';
import { parseToman } from '../lib/money.js';
import { text, oneOf, id as idField } from '../lib/validate.js';
import { expensePaidEntries } from '../domain/ledger.js';
import { signedAmount } from '../domain/cash.js';
import { audit, branchFilter, postLedger, recordCashMovement, requireBranch, requireOpenCashSession, requirePermission, requireAnyPermission } from './common.js';

export const EXPENSE_CATEGORIES = ['direct_job', 'daily_branch', 'monthly_operating', 'inventory_purchase', 'maintenance', 'other'];
export const CATEGORY_LABELS = { direct_job: 'Direct job expense', daily_branch: 'Daily branch expense', monthly_operating: 'Monthly operating expense', inventory_purchase: 'Inventory purchase', maintenance: 'Maintenance', other: 'Other' };

function present(row) {
  return { id: row.id, branchId: row.branch_id, category: row.category, categoryLabel: CATEGORY_LABELS[row.category], description: row.description, amount: row.amount,
    paymentSource: row.payment_source, status: row.status, note: row.note, createdBy: row.created_by_name, createdAt: row.created_at, paidAt: row.paid_at };
}

export function listExpenses(ctx, { status = '' } = {}) {
  requireAnyPermission(ctx, ['expenses.create', 'expenses.pay', 'approvals.expense', 'reports.view']);
  const scope = branchFilter(ctx, 'e.branch_id');
  const params = { business: ctx.actor.businessId, ...scope.params };
  let sql = `SELECT e.*, u.display_name AS created_by_name FROM expenses e JOIN users u ON u.id = e.created_by WHERE e.business_id = :business AND ${scope.sql}`;
  if (status) { params.status = oneOf(status, ['submitted', 'approved', 'rejected', 'paid'], 'Status'); sql += ' AND e.status = :status'; }
  return ctx.db.all(`${sql} ORDER BY e.created_at DESC LIMIT 200`, params).map(present);
}

/** Every expense is submitted for approval by someone other than its creator. */
export function createExpense(ctx, input) {
  requirePermission(ctx, 'expenses.create');
  const branchId = idField(input.branchId, 'Branch');
  if (!ctx.db.get('SELECT 1 FROM branches WHERE id = :id AND business_id = :business', { id: branchId, business: ctx.actor.businessId })) throw notFound('Branch');
  requireBranch(ctx, branchId);
  const fields = {
    category: oneOf(input.category, EXPENSE_CATEGORIES, 'Category'),
    description: text(input.description, 'Description', { required: true, max: 160 }),
    amount: parseToman(input.amount, 'Amount', { allowZero: false }),
    source: oneOf(input.paymentSource || 'cash', ['cash', 'card', 'bank_transfer'], 'Payment source'),
    note: text(input.note, 'Supporting note', { max: 500 })
  };
  const id = newId();
  ctx.db.run(`INSERT INTO expenses(id, business_id, branch_id, category, description, amount, payment_source, note, created_by) VALUES (:id, :business, :branch, :category, :description, :amount, :source, :note, :user)`,
    { id, business: ctx.actor.businessId, branch: branchId, user: ctx.actor.userId, ...fields });
  ctx.db.run(`INSERT INTO approvals(id, business_id, branch_id, kind, subject_type, subject_id, amount, reason, payload, requested_by) VALUES (:aid, :business, :branch, 'expense', 'expense', :id, :amount, :reason, :payload, :user)`,
    { aid: newId(), business: ctx.actor.businessId, branch: branchId, id, amount: fields.amount, reason: fields.description, payload: JSON.stringify({ category: CATEGORY_LABELS[fields.category], source: fields.source }), user: ctx.actor.userId });
  audit(ctx, { action: 'expense.submitted', entityType: 'expense', entityId: id, branchId, after: fields });
  return present(ctx.db.get('SELECT e.*, u.display_name AS created_by_name FROM expenses e JOIN users u ON u.id = e.created_by WHERE e.id = :id', { id }));
}

export function payExpense(ctx, expenseId) {
  requirePermission(ctx, 'expenses.pay');
  const expense = ctx.db.get('SELECT * FROM expenses WHERE id = :id AND business_id = :business', { id: expenseId, business: ctx.actor.businessId });
  if (!expense) throw notFound('Expense');
  requireBranch(ctx, expense.branch_id);
  if (expense.status !== 'approved') throw new AppError('EXPENSE_NOT_APPROVED', expense.status === 'paid' ? 'This expense is already paid.' : 'Only approved expenses can be paid.', 422);
  if (expense.payment_source === 'cash') {
    const session = requireOpenCashSession(ctx, expense.branch_id);
    recordCashMovement(ctx, { sessionId: session.id, kind: 'expense', amount: signedAmount('expense', expense.amount), referenceType: 'expense', referenceId: expense.id, note: expense.description });
  }
  ctx.db.run(`UPDATE expenses SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: expenseId });
  postLedger(ctx, { branchId: expense.branch_id, eventType: 'expense_paid', sourceType: 'expense', sourceId: expense.id, idempotencyKey: `expense:${expense.id}`, memo: expense.description,
    entries: expensePaidEntries({ category: expense.category, amount: expense.amount, source: expense.payment_source }) });
  audit(ctx, { action: 'expense.paid', entityType: 'expense', entityId: expense.id, branchId: expense.branch_id, after: { amount: expense.amount, source: expense.payment_source } });
  return present(ctx.db.get('SELECT e.*, u.display_name AS created_by_name FROM expenses e JOIN users u ON u.id = e.created_by WHERE e.id = :id', { id: expenseId }));
}
