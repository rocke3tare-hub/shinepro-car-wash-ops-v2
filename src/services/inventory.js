import { newId } from '../db/database.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { parseToman } from '../lib/money.js';
import { text, oneOf, int, id as idField } from '../lib/validate.js';
import { audit, branchFilter, requireBranch, requirePermission } from './common.js';

export const MOVEMENT_KINDS = ['purchase', 'usage', 'waste', 'return', 'adjustment'];
const INBOUND = new Set(['purchase', 'return']);

function stockOf(db, itemId) {
  return db.get('SELECT COALESCE(sum(quantity), 0) AS stock FROM stock_movements WHERE item_id = :id', { id: itemId }).stock;
}

function present(db, row) {
  const stock = stockOf(db, row.id);
  const last = db.get('SELECT kind, quantity, created_at FROM stock_movements WHERE item_id = :id ORDER BY created_at DESC, rowid DESC LIMIT 1', { id: row.id });
  return { id: row.id, branchId: row.branch_id, name: row.name, category: row.category, unit: row.unit, minimumStock: row.minimum_stock, unitCost: row.unit_cost,
    status: row.status, stock, low: row.status === 'active' && stock < row.minimum_stock, lastMovement: last || null };
}

export function listItems(ctx, { filter = 'all' } = {}) {
  requirePermission(ctx, 'inventory.view');
  const scope = branchFilter(ctx);
  const rows = ctx.db.all(`SELECT * FROM inventory_items WHERE business_id = :business AND ${scope.sql} ORDER BY status, name`, { business: ctx.actor.businessId, ...scope.params });
  const items = rows.map(row => present(ctx.db, row));
  if (filter === 'low') return items.filter(i => i.low);
  if (filter === 'inactive') return items.filter(i => i.status === 'inactive');
  if (filter === 'active') return items.filter(i => i.status === 'active');
  return items;
}

function load(ctx, itemId) {
  const row = ctx.db.get('SELECT * FROM inventory_items WHERE id = :id AND business_id = :business', { id: itemId, business: ctx.actor.businessId });
  if (!row) throw notFound('Inventory item');
  requireBranch(ctx, row.branch_id);
  return row;
}

export function createItem(ctx, input) {
  requirePermission(ctx, 'inventory.manage');
  const branchId = idField(input.branchId, 'Branch');
  if (!ctx.db.get('SELECT 1 FROM branches WHERE id = :id AND business_id = :business', { id: branchId, business: ctx.actor.businessId })) throw notFound('Branch');
  requireBranch(ctx, branchId);
  const fields = {
    name: text(input.name, 'Item name', { required: true, max: 80 }),
    category: text(input.category, 'Category', { max: 40 }) || 'Supplies',
    unit: text(input.unit, 'Unit', { required: true, max: 12 }),
    minimum: int(input.minimumStock ?? 0, 'Minimum stock', { min: 0, max: 1_000_000 }),
    cost: parseToman(input.unitCost ?? 0, 'Unit cost')
  };
  if (ctx.db.get('SELECT 1 FROM inventory_items WHERE branch_id = :branch AND name = :name', { branch: branchId, name: fields.name })) throw conflict('DUPLICATE_ITEM', 'This branch already has an item with that name.');
  const id = newId();
  ctx.db.run('INSERT INTO inventory_items(id, business_id, branch_id, name, category, unit, minimum_stock, unit_cost) VALUES (:id, :business, :branch, :name, :category, :unit, :minimum, :cost)',
    { id, business: ctx.actor.businessId, branch: branchId, ...fields });
  audit(ctx, { action: 'inventory.item_created', entityType: 'inventory_item', entityId: id, branchId, after: fields });
  return present(ctx.db, load(ctx, id));
}

export function updateItem(ctx, itemId, input) {
  requirePermission(ctx, 'inventory.manage');
  const row = load(ctx, itemId);
  const next = {
    category: input.category !== undefined ? (text(input.category, 'Category', { max: 40 }) || 'Supplies') : row.category,
    minimum: input.minimumStock !== undefined ? int(input.minimumStock, 'Minimum stock', { min: 0, max: 1_000_000 }) : row.minimum_stock,
    cost: input.unitCost !== undefined ? parseToman(input.unitCost, 'Unit cost') : row.unit_cost,
    status: input.status !== undefined ? oneOf(input.status, ['active', 'inactive'], 'Status') : row.status
  };
  ctx.db.run('UPDATE inventory_items SET category = :category, minimum_stock = :minimum, unit_cost = :cost, status = :status WHERE id = :id', { id: itemId, ...next });
  audit(ctx, { action: 'inventory.item_updated', entityType: 'inventory_item', entityId: itemId, branchId: row.branch_id, before: { category: row.category, minimum: row.minimum_stock, cost: row.unit_cost, status: row.status }, after: next });
  return present(ctx.db, load(ctx, itemId));
}

/** Stock is the sum of movements; it can never go negative. */
export function recordMovement(ctx, itemId, input) {
  requirePermission(ctx, 'inventory.manage');
  const row = load(ctx, itemId);
  if (row.status !== 'active') throw new AppError('ITEM_INACTIVE', 'Reactivate the item before recording movements.', 422);
  const kind = oneOf(input.kind, MOVEMENT_KINDS, 'Movement type');
  const reason = text(input.reason, 'Reason', { required: true, max: 200 });
  let quantity;
  if (kind === 'adjustment') {
    quantity = int(input.quantity, 'Quantity', { min: -1_000_000, max: 1_000_000 });
    if (quantity === 0) throw new AppError('VALIDATION_ERROR', 'An adjustment must change the stock.', 422);
  } else {
    const magnitude = int(input.quantity, 'Quantity', { min: 1, max: 1_000_000 });
    quantity = INBOUND.has(kind) ? magnitude : -magnitude;
  }
  const before = stockOf(ctx.db, itemId);
  if (before + quantity < 0) throw new AppError('INSUFFICIENT_STOCK', `Only ${before} ${row.unit} in stock.`, 422);
  const unitCost = kind === 'purchase' ? parseToman(input.unitCost ?? row.unit_cost, 'Unit cost') : row.unit_cost;
  ctx.db.run('INSERT INTO stock_movements(id, item_id, kind, quantity, unit_cost, reason, created_by) VALUES (:id, :item, :kind, :quantity, :cost, :reason, :user)',
    { id: newId(), item: itemId, kind, quantity, cost: unitCost, reason, user: ctx.actor.userId });
  audit(ctx, { action: 'inventory.movement', entityType: 'inventory_item', entityId: itemId, branchId: row.branch_id, before: { stock: before }, after: { stock: before + quantity, kind, quantity }, reason });
  return present(ctx.db, load(ctx, itemId));
}
