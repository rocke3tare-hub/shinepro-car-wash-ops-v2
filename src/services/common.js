import { AppError, forbidden, notFound } from '../lib/errors.js';
import { can, canAccessBranch } from '../domain/permissions.js';
import { balanced } from '../domain/ledger.js';
import { newId, parseJson } from '../db/database.js';

export const DEFAULT_SETTINGS = Object.freeze({
  discountApprovalBp: 1000,        // discounts above 10% of the price need approval
  cashReviewThreshold: 500000,     // closing differences above this need review
  loyaltyTomanPerPoint: 10000,     // 1 loyalty point per 10,000 toman paid
  revenueTargetDaily: 15000000,    // used by the branch scorecard
  jobCodePrefix: 'CW'
});

export function requirePermission(ctx, permission) {
  if (!ctx.actor) throw new AppError('AUTHENTICATION_REQUIRED', 'Sign in is required.', 401);
  if (!can(ctx.actor, permission)) throw forbidden();
}

export function requireAnyPermission(ctx, permissions) {
  if (!ctx.actor) throw new AppError('AUTHENTICATION_REQUIRED', 'Sign in is required.', 401);
  if (!permissions.some(p => can(ctx.actor, p))) throw forbidden();
}

export function requireBranch(ctx, branchId) {
  if (!canAccessBranch(ctx.actor, branchId)) throw new AppError('BRANCH_ACCESS_DENIED', 'This branch is outside your assigned scope.', 403);
}

/** SQL fragment + params restricting a branch_id column to the actor's scope. */
export function branchFilter(ctx, column = 'branch_id') {
  if (ctx.actor.allBranches) return { sql: '1 = 1', params: {} };
  if (!ctx.actor.branchIds.length) return { sql: '1 = 0', params: {} };
  const params = {};
  const names = ctx.actor.branchIds.map((id, index) => { params[`scope_branch_${index}`] = id; return `:scope_branch_${index}`; });
  return { sql: `${column} IN (${names.join(', ')})`, params };
}

export function settings(ctx) {
  const row = ctx.db.get('SELECT settings FROM businesses WHERE id = :id', { id: ctx.actor.businessId });
  return { ...DEFAULT_SETTINGS, ...parseJson(row?.settings, {}) };
}

/** Load a tenant row and verify it belongs to the actor's business (and branch, if it has one). */
export function loadScoped(ctx, table, id, label) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid table name');
  const row = ctx.db.get(`SELECT * FROM ${table} WHERE id = :id AND business_id = :business`, { id, business: ctx.actor.businessId });
  if (!row) throw notFound(label);
  if (row.branch_id) requireBranch(ctx, row.branch_id);
  return row;
}

export function audit(ctx, { action, entityType, entityId = null, branchId = null, before = null, after = null, reason = null }) {
  ctx.db.run(
    `INSERT INTO audit_events(business_id, branch_id, user_id, role, action, entity_type, entity_id, before_values, after_values, reason, request_id)
     VALUES (:business, :branch, :user, :role, :action, :entityType, :entityId, :before, :after, :reason, :requestId)`,
    {
      business: ctx.actor?.businessId ?? null,
      branch: branchId,
      user: ctx.actor?.userId ?? null,
      role: ctx.actor?.roles?.join(',') ?? null,
      action,
      entityType,
      entityId,
      before: before == null ? null : JSON.stringify(before),
      after: after == null ? null : JSON.stringify(after),
      reason,
      requestId: ctx.requestId ?? null
    }
  );
}

/** Post a balanced ledger transaction exactly once per idempotency key. */
export function postLedger(ctx, { branchId, eventType, sourceType, sourceId, idempotencyKey, entries, memo = null }) {
  const lines = entries.length ? balanced(entries) : [];
  if (!lines.length) return null;
  const existing = ctx.db.get('SELECT id FROM ledger_transactions WHERE idempotency_key = :key', { key: idempotencyKey });
  if (existing) return existing.id;
  const id = newId();
  ctx.db.run(
    `INSERT INTO ledger_transactions(id, business_id, branch_id, event_type, source_type, source_id, idempotency_key, memo, created_by)
     VALUES (:id, :business, :branch, :eventType, :sourceType, :sourceId, :key, :memo, :user)`,
    { id, business: ctx.actor.businessId, branch: branchId, eventType, sourceType, sourceId, key: idempotencyKey, memo, user: ctx.actor.userId }
  );
  for (const line of lines) {
    ctx.db.run('INSERT INTO ledger_entries(transaction_id, account, debit, credit) VALUES (:tx, :account, :debit, :credit)', { tx: id, ...line });
  }
  return id;
}

export function nextCounter(ctx, key) {
  ctx.db.run(
    `INSERT INTO counters(business_id, key, value) VALUES (:business, :key, 1)
     ON CONFLICT(business_id, key) DO UPDATE SET value = value + 1`,
    { business: ctx.actor.businessId, key }
  );
  return ctx.db.get('SELECT value FROM counters WHERE business_id = :business AND key = :key', { business: ctx.actor.businessId, key }).value;
}

export function openCashSession(ctx, branchId) {
  return ctx.db.get(`SELECT * FROM cash_sessions WHERE branch_id = :branch AND status = 'open'`, { branch: branchId }) || null;
}

/** Cash movements need an open register so every toman lands in a reconcilable drawer. */
export function requireOpenCashSession(ctx, branchId) {
  const session = openCashSession(ctx, branchId);
  if (!session) throw new AppError('CASH_REGISTER_CLOSED', 'Open the cash register for this branch before recording cash.', 422);
  return session;
}

export function recordCashMovement(ctx, { sessionId, kind, amount, referenceType = null, referenceId = null, note = null }) {
  ctx.db.run(
    `INSERT INTO cash_movements(id, cash_session_id, kind, amount, reference_type, reference_id, note, created_by)
     VALUES (:id, :session, :kind, :amount, :refType, :refId, :note, :user)`,
    { id: newId(), session: sessionId, kind, amount, refType: referenceType, refId: referenceId, note, user: ctx.actor.userId }
  );
}

export function expectVersion(row, expectedVersion, label = 'record') {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return;
  if (Number(expectedVersion) !== row.version) {
    throw new AppError('CONCURRENT_UPDATE', `This ${label} changed after you opened it. Reload and review the latest version.`, 409);
  }
}
