import { newId } from '../db/database.js';
import { notFound } from '../lib/errors.js';
import { text, phone, bool, id as idField } from '../lib/validate.js';
import { audit, branchFilter, requireBranch, requirePermission, requireAnyPermission } from './common.js';

function present(row) {
  return { id: row.id, branchId: row.branch_id, userId: row.user_id, name: row.name, title: row.title, phone: row.phone, onShift: Boolean(row.on_shift), status: row.status };
}

export function listWorkers(ctx, { includeSuspended = false } = {}) {
  requireAnyPermission(ctx, ['jobs.view', 'jobs.assign', 'workers.manage', 'earnings.view']);
  const scope = branchFilter(ctx);
  return ctx.db.all(`SELECT * FROM workers WHERE business_id = :business AND ${scope.sql} ${includeSuspended ? '' : "AND status = 'active'"} ORDER BY name`,
    { business: ctx.actor.businessId, ...scope.params }).map(present);
}

function load(ctx, workerId) {
  const row = ctx.db.get('SELECT * FROM workers WHERE id = :id AND business_id = :business', { id: workerId, business: ctx.actor.businessId });
  if (!row) throw notFound('Worker');
  requireBranch(ctx, row.branch_id);
  return row;
}

export function createWorker(ctx, input) {
  requirePermission(ctx, 'workers.manage');
  const branchId = idField(input.branchId, 'Branch');
  if (!ctx.db.get('SELECT 1 FROM branches WHERE id = :id AND business_id = :business', { id: branchId, business: ctx.actor.businessId })) throw notFound('Branch');
  requireBranch(ctx, branchId);
  const fields = {
    name: text(input.name, 'Worker name', { required: true, max: 80 }),
    title: text(input.title, 'Title', { max: 60 }) || 'Car-wash worker',
    phone: phone(input.phone)
  };
  const id = newId();
  ctx.db.run('INSERT INTO workers(id, business_id, branch_id, name, title, phone) VALUES (:id, :business, :branch, :name, :title, :phone)', { id, business: ctx.actor.businessId, branch: branchId, ...fields });
  audit(ctx, { action: 'worker.created', entityType: 'worker', entityId: id, branchId, after: fields });
  return present(load(ctx, id));
}

export function updateWorker(ctx, workerId, input) {
  requirePermission(ctx, 'workers.manage');
  const row = load(ctx, workerId);
  const next = {
    name: input.name !== undefined ? text(input.name, 'Worker name', { required: true, max: 80 }) : row.name,
    title: input.title !== undefined ? (text(input.title, 'Title', { max: 60 }) || 'Car-wash worker') : row.title,
    phone: input.phone !== undefined ? phone(input.phone) : row.phone,
    onShift: input.onShift !== undefined ? (bool(input.onShift) ? 1 : 0) : row.on_shift,
    status: input.status !== undefined ? (input.status === 'suspended' ? 'suspended' : 'active') : row.status
  };
  ctx.db.run('UPDATE workers SET name = :name, title = :title, phone = :phone, on_shift = :onShift, status = :status WHERE id = :id', { id: workerId, ...next });
  audit(ctx, { action: 'worker.updated', entityType: 'worker', entityId: workerId, branchId: row.branch_id, before: present(row), after: next });
  return present(load(ctx, workerId));
}
