import crypto from 'node:crypto';
import { newId, parseJson } from '../db/database.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { text, email, phone, oneOf, id as idField, int } from '../lib/validate.js';
import { parseToman, parseBasisPoints } from '../lib/money.js';
import { ROLES, ROLE_LABELS } from '../domain/permissions.js';
import { audit, branchFilter, requirePermission, settings, DEFAULT_SETTINGS } from './common.js';
import { hashPassword, assertPasswordPolicy, revokeAllSessions } from './auth.js';

export function listBranches(ctx) {
  const scope = branchFilter(ctx, 'id');
  return ctx.db.all(`SELECT id, name, timezone, bays, status FROM branches WHERE business_id = :business AND ${scope.sql} ORDER BY created_at`, { business: ctx.actor.businessId, ...scope.params })
    .map(b => ({ ...b, bays: parseJson(b.bays, []) }));
}

export function auditLog(ctx, { limit = 200, entityType = '' } = {}) {
  requirePermission(ctx, 'audit.view');
  const params = { business: ctx.actor.businessId, limit: Math.min(Math.max(Number(limit) || 200, 1), 500) };
  let where = 'a.business_id = :business';
  if (!ctx.actor.allBranches) {
    // Branch-scoped readers see their branches' events only.
    const scope = branchFilter(ctx, 'a.branch_id');
    Object.assign(params, scope.params);
    where += ` AND ${scope.sql}`;
  }
  if (entityType) { params.entityType = text(entityType, 'Entity type', { max: 40 }); where += ' AND a.entity_type = :entityType'; }
  return ctx.db.all(`SELECT a.id, a.action, a.entity_type, a.entity_id, a.branch_id, a.before_values, a.after_values, a.reason, a.created_at, u.display_name AS actor
    FROM audit_events a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT :limit`, params)
    .map(row => ({ ...row, before_values: parseJson(row.before_values, null), after_values: parseJson(row.after_values, null) }));
}

// ---------- Staff ----------

const ASSIGNABLE_ROLES = ROLES.filter(role => role !== 'owner' && role !== 'customer');

export function listStaff(ctx) {
  requirePermission(ctx, 'staff.manage');
  const rows = ctx.db.all(`SELECT u.id, u.email, u.display_name, u.status, u.last_login_at, m.id AS membership_id, m.role, m.branch_id, m.status AS membership_status
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = :business AND m.role <> 'customer' ORDER BY u.display_name, m.role`, { business: ctx.actor.businessId });
  const users = new Map();
  for (const row of rows) {
    const user = users.get(row.id) || { id: row.id, email: row.email, displayName: row.display_name, status: row.status, lastLoginAt: row.last_login_at, roles: [] };
    if (row.membership_status === 'active') user.roles.push({ membershipId: row.membership_id, role: row.role, label: ROLE_LABELS[row.role], branchId: row.branch_id });
    users.set(row.id, user);
  }
  return { users: [...users.values()], assignableRoles: ASSIGNABLE_ROLES.map(role => ({ role, label: ROLE_LABELS[role] })) };
}

/**
 * Create a staff account with a one-time password shown to the administrator.
 * Owner and customer roles can never be granted through this endpoint.
 */
export function createStaff(ctx, config, input) {
  requirePermission(ctx, 'staff.manage');
  const role = oneOf(input.role, ASSIGNABLE_ROLES, 'Role');
  const branchId = input.branchId ? idField(input.branchId, 'Branch') : null;
  if (branchId && !ctx.db.get('SELECT 1 FROM branches WHERE id = :id AND business_id = :business', { id: branchId, business: ctx.actor.businessId })) throw notFound('Branch');
  if (!branchId && !['company_admin', 'accountant'].includes(role)) throw invalid('Choose the branch this person works at.', { field: 'branchId' });
  const address = email(input.email);
  const displayName = text(input.displayName, 'Name', { required: true, max: 80 });
  let user = ctx.db.get('SELECT * FROM users WHERE email = :email', { email: address });
  let temporaryPassword = null;
  if (!user) {
    temporaryPassword = crypto.randomBytes(9).toString('base64url');
    const id = newId();
    ctx.db.run(`INSERT INTO users(id, email, password_hash, display_name, phone, status) VALUES (:id, :email, :hash, :name, :phone, 'active')`,
      { id, email: address, hash: hashPassword(temporaryPassword, config.passwordPepper), name: displayName, phone: phone(input.phone) });
    user = ctx.db.get('SELECT * FROM users WHERE id = :id', { id });
  } else if (user.customer_id) {
    throw conflict('ACCOUNT_IS_CUSTOMER', 'This email belongs to a customer account. Use a work email for staff.');
  }
  const existing = ctx.db.get(`SELECT * FROM memberships WHERE business_id = :business AND user_id = :user AND role = :role AND COALESCE(branch_id, '*') = COALESCE(:branch, '*')`, { business: ctx.actor.businessId, user: user.id, role, branch: branchId });
  if (existing?.status === 'active') throw conflict('ROLE_EXISTS', 'This person already has that role.');
  if (existing) ctx.db.run(`UPDATE memberships SET status = 'active' WHERE id = :id`, { id: existing.id });
  else ctx.db.run('INSERT INTO memberships(id, business_id, user_id, role, branch_id) VALUES (:id, :business, :user, :role, :branch)', { id: newId(), business: ctx.actor.businessId, user: user.id, role, branch: branchId });
  if (role === 'worker' || role === 'team_leader') {
    const worker = ctx.db.get('SELECT * FROM workers WHERE user_id = :user', { user: user.id });
    if (!worker && branchId) ctx.db.run(`INSERT INTO workers(id, business_id, branch_id, user_id, name, title) VALUES (:id, :business, :branch, :user, :name, :title)`,
      { id: newId(), business: ctx.actor.businessId, branch: branchId, user: user.id, name: displayName, title: ROLE_LABELS[role] });
  }
  audit(ctx, { action: 'staff.role_granted', entityType: 'user', entityId: user.id, branchId, after: { email: address, role } });
  return { userId: user.id, email: address, role, temporaryPassword };
}

export function revokeRole(ctx, membershipId) {
  requirePermission(ctx, 'staff.manage');
  const membership = ctx.db.get('SELECT * FROM memberships WHERE id = :id AND business_id = :business', { id: membershipId, business: ctx.actor.businessId });
  if (!membership) throw notFound('Role assignment');
  if (membership.role === 'owner') throw forbidden('The owner role cannot be revoked here.');
  if (membership.user_id === ctx.actor.userId) throw forbidden('You cannot revoke your own role.');
  ctx.db.run(`UPDATE memberships SET status = 'revoked' WHERE id = :id`, { id: membershipId });
  const remaining = ctx.db.get(`SELECT count(*) AS n FROM memberships WHERE user_id = :user AND status = 'active'`, { user: membership.user_id }).n;
  if (!remaining) revokeAllSessions(ctx.db, membership.user_id);
  audit(ctx, { action: 'staff.role_revoked', entityType: 'user', entityId: membership.user_id, branchId: membership.branch_id, before: { role: membership.role } });
  return listStaff(ctx);
}

export function changePassword(ctx, config, input, verify) {
  const user = ctx.db.get('SELECT * FROM users WHERE id = :id', { id: ctx.actor.userId });
  if (!verify(String(input.currentPassword || ''), user.password_hash, config.passwordPepper)) throw new AppError('WRONG_PASSWORD', 'Your current password is incorrect.', 403);
  assertPasswordPolicy(input.newPassword);
  ctx.db.run('UPDATE users SET password_hash = :hash WHERE id = :id', { id: user.id, hash: hashPassword(input.newPassword, config.passwordPepper) });
  revokeAllSessions(ctx.db, user.id);
  audit(ctx, { action: 'user.password_changed', entityType: 'user', entityId: user.id });
}

// ---------- Business settings ----------

export function getSettings(ctx) {
  return settings(ctx);
}

export function updateSettings(ctx, input) {
  requirePermission(ctx, 'settings.manage');
  const before = settings(ctx);
  const next = {
    discountApprovalBp: input.discountApprovalBp !== undefined ? parseBasisPoints(input.discountApprovalBp, 'Discount approval threshold') : before.discountApprovalBp,
    cashReviewThreshold: input.cashReviewThreshold !== undefined ? parseToman(input.cashReviewThreshold, 'Cash review threshold') : before.cashReviewThreshold,
    loyaltyTomanPerPoint: input.loyaltyTomanPerPoint !== undefined ? int(input.loyaltyTomanPerPoint, 'Toman per loyalty point', { min: 0, max: 100_000_000 }) : before.loyaltyTomanPerPoint,
    revenueTargetDaily: input.revenueTargetDaily !== undefined ? parseToman(input.revenueTargetDaily, 'Daily revenue target') : before.revenueTargetDaily,
    jobCodePrefix: input.jobCodePrefix !== undefined ? (text(input.jobCodePrefix, 'Job code prefix', { required: true, max: 6 }).toUpperCase()) : before.jobCodePrefix
  };
  if (!/^[A-Z0-9]{1,6}$/.test(next.jobCodePrefix)) throw invalid('The job code prefix may only contain letters and digits.');
  ctx.db.run('UPDATE businesses SET settings = :settings WHERE id = :id', { id: ctx.actor.businessId, settings: JSON.stringify(next) });
  audit(ctx, { action: 'settings.updated', entityType: 'business', entityId: ctx.actor.businessId, before, after: next });
  return next;
}

export { DEFAULT_SETTINGS };
