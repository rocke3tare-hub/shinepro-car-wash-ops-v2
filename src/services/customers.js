import { newId } from '../db/database.js';
import { conflict, notFound } from '../lib/errors.js';
import { parseToman } from '../lib/money.js';
import { text, phone, oneOf } from '../lib/validate.js';
import { VEHICLE_TYPES } from '../domain/pricing.js';
import { audit, expectVersion, requirePermission } from './common.js';

export const CUSTOMER_TYPES = ['walk_in', 'member', 'loyalty', 'fleet', 'business'];

function presentCustomer(row, stats = {}) {
  return {
    id: row.id, name: row.name, phone: row.phone, customerType: row.customer_type, note: row.note,
    creditLimit: row.credit_limit, status: row.status, createdAt: row.created_at, version: row.version, ...stats
  };
}

export function presentVehicle(row) {
  return { id: row.id, customerId: row.customer_id, plate: row.plate, vehicleType: row.vehicle_type, brand: row.brand, model: row.model, colour: row.colour, notes: row.notes };
}

function stats(db, customerId) {
  const s = db.get(`SELECT count(*) AS visits, COALESCE(sum(final_price), 0) AS spend FROM jobs WHERE customer_id = :id AND payment_status = 'paid'`, { id: customerId });
  const credit = db.get(`SELECT COALESCE(sum(pp.amount), 0) AS used FROM payment_parts pp JOIN payments p ON p.id = pp.payment_id JOIN jobs j ON j.id = p.job_id
    WHERE j.customer_id = :id AND pp.method = 'customer_credit' AND p.status = 'confirmed'`, { id: customerId });
  const loyalty = db.get('SELECT COALESCE(sum(points), 0) AS points FROM loyalty_transactions WHERE customer_id = :id', { id: customerId });
  return { visits: s.visits, spend: s.spend, creditUsed: credit.used, loyaltyPoints: loyalty.points };
}

export function listCustomers(ctx, { q = '', type = '' } = {}) {
  requirePermission(ctx, 'customers.view');
  const params = { business: ctx.actor.businessId, q: `%${String(q).slice(0, 60).replace(/[%_\\]/g, ch => `\\${ch}`)}%` };
  let sql = `SELECT * FROM customers WHERE business_id = :business AND status = 'active' AND (name LIKE :q ESCAPE '\\' OR COALESCE(phone, '') LIKE :q ESCAPE '\\')`;
  if (type) { params.type = oneOf(type, CUSTOMER_TYPES, 'Customer type'); sql += ' AND customer_type = :type'; }
  sql += ' ORDER BY name LIMIT 200';
  return ctx.db.all(sql, params).map(row => presentCustomer(row, stats(ctx.db, row.id)));
}

export function getCustomer(ctx, id) {
  requirePermission(ctx, 'customers.view');
  const row = ctx.db.get('SELECT * FROM customers WHERE id = :id AND business_id = :business', { id, business: ctx.actor.businessId });
  if (!row) throw notFound('Customer');
  const vehicles = ctx.db.all('SELECT * FROM vehicles WHERE customer_id = :id ORDER BY created_at', { id }).map(presentVehicle);
  const jobs = ctx.db.all(`SELECT id, code, service_name, final_price, status, payment_status, created_at FROM jobs WHERE customer_id = :id ORDER BY created_at DESC LIMIT 20`, { id });
  return { ...presentCustomer(row, stats(ctx.db, id)), vehicles, jobs };
}

function customerFields(input, existing = {}) {
  return {
    name: text(input.name ?? existing.name, 'Customer name', { required: true, max: 120 }),
    phone: phone(input.phone !== undefined ? input.phone : existing.phone),
    customerType: oneOf(input.customerType ?? existing.customer_type ?? 'walk_in', CUSTOMER_TYPES, 'Customer type'),
    note: text(input.note !== undefined ? input.note : existing.note, 'Note', { max: 500 })
  };
}

export function createCustomer(ctx, input) {
  requirePermission(ctx, 'customers.manage');
  const fields = customerFields(input);
  const id = newId();
  ctx.db.run(`INSERT INTO customers(id, business_id, name, phone, customer_type, note, created_by) VALUES (:id, :business, :name, :phone, :customerType, :note, :user)`,
    { id, business: ctx.actor.businessId, user: ctx.actor.userId, ...fields });
  audit(ctx, { action: 'customer.created', entityType: 'customer', entityId: id, after: fields });
  return getCustomer(ctx, id);
}

export function updateCustomer(ctx, id, input) {
  requirePermission(ctx, 'customers.manage');
  const row = ctx.db.get('SELECT * FROM customers WHERE id = :id AND business_id = :business', { id, business: ctx.actor.businessId });
  if (!row) throw notFound('Customer');
  expectVersion(row, input.expectedVersion, 'customer');
  const fields = customerFields(input, row);
  ctx.db.run('UPDATE customers SET name = :name, phone = :phone, customer_type = :customerType, note = :note, version = version + 1 WHERE id = :id', { id, ...fields });
  audit(ctx, { action: 'customer.updated', entityType: 'customer', entityId: id, before: { name: row.name, phone: row.phone, customerType: row.customer_type, note: row.note }, after: fields });
  return getCustomer(ctx, id);
}

/** Credit limits are financial: only roles that approve cash/refunds may set them. */
export function setCreditLimit(ctx, id, input) {
  requirePermission(ctx, 'approvals.cash');
  const row = ctx.db.get('SELECT * FROM customers WHERE id = :id AND business_id = :business', { id, business: ctx.actor.businessId });
  if (!row) throw notFound('Customer');
  const limit = parseToman(input.creditLimit, 'Credit limit');
  ctx.db.run('UPDATE customers SET credit_limit = :limit, version = version + 1 WHERE id = :id', { id, limit });
  audit(ctx, { action: 'customer.credit_limit_set', entityType: 'customer', entityId: id, before: { creditLimit: row.credit_limit }, after: { creditLimit: limit }, reason: text(input.reason, 'Reason', { required: true, max: 300 }) });
  return getCustomer(ctx, id);
}

export function normalizePlate(value) {
  return text(value, 'Registration plate', { required: true, max: 32 }).replace(/\s+/g, ' ');
}

export function createVehicle(ctx, input) {
  requirePermission(ctx, 'customers.manage');
  const customerId = input.customerId || null;
  if (customerId && !ctx.db.get('SELECT 1 FROM customers WHERE id = :id AND business_id = :business', { id: customerId, business: ctx.actor.businessId })) throw notFound('Customer');
  const fields = {
    plate: normalizePlate(input.plate),
    vehicleType: oneOf(input.vehicleType, VEHICLE_TYPES, 'Vehicle type'),
    brand: text(input.brand, 'Brand', { max: 40 }),
    model: text(input.model, 'Model', { max: 40 }),
    colour: text(input.colour, 'Colour', { max: 30 }),
    notes: text(input.notes, 'Notes', { max: 300 })
  };
  if (ctx.db.get('SELECT 1 FROM vehicles WHERE business_id = :business AND plate = :plate', { business: ctx.actor.businessId, plate: fields.plate })) throw conflict('DUPLICATE_PLATE', 'A vehicle with this plate is already registered.');
  const id = newId();
  ctx.db.run(`INSERT INTO vehicles(id, business_id, customer_id, plate, vehicle_type, brand, model, colour, notes) VALUES (:id, :business, :customer, :plate, :vehicleType, :brand, :model, :colour, :notes)`,
    { id, business: ctx.actor.businessId, customer: customerId, ...fields });
  audit(ctx, { action: 'vehicle.created', entityType: 'vehicle', entityId: id, after: { customerId, ...fields } });
  return presentVehicle(ctx.db.get('SELECT * FROM vehicles WHERE id = :id', { id }));
}

export function updateVehicle(ctx, id, input) {
  requirePermission(ctx, 'customers.manage');
  const row = ctx.db.get('SELECT * FROM vehicles WHERE id = :id AND business_id = :business', { id, business: ctx.actor.businessId });
  if (!row) throw notFound('Vehicle');
  const fields = {
    vehicleType: input.vehicleType !== undefined ? oneOf(input.vehicleType, VEHICLE_TYPES, 'Vehicle type') : row.vehicle_type,
    brand: input.brand !== undefined ? text(input.brand, 'Brand', { max: 40 }) : row.brand,
    model: input.model !== undefined ? text(input.model, 'Model', { max: 40 }) : row.model,
    colour: input.colour !== undefined ? text(input.colour, 'Colour', { max: 30 }) : row.colour,
    notes: input.notes !== undefined ? text(input.notes, 'Notes', { max: 300 }) : row.notes
  };
  ctx.db.run('UPDATE vehicles SET vehicle_type = :vehicleType, brand = :brand, model = :model, colour = :colour, notes = :notes WHERE id = :id', { id, ...fields });
  audit(ctx, { action: 'vehicle.updated', entityType: 'vehicle', entityId: id, before: presentVehicle(row), after: fields });
  return presentVehicle(ctx.db.get('SELECT * FROM vehicles WHERE id = :id', { id }));
}

export function findVehicleByPlate(ctx, plate) {
  requirePermission(ctx, 'customers.view');
  const row = ctx.db.get('SELECT * FROM vehicles WHERE business_id = :business AND plate = :plate', { business: ctx.actor.businessId, plate: normalizePlate(plate) });
  if (!row) return null;
  const customer = row.customer_id ? ctx.db.get('SELECT id, name, phone FROM customers WHERE id = :id', { id: row.customer_id }) : null;
  return { ...presentVehicle(row), customer };
}

