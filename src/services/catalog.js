import { newId, nowIso, parseJson } from '../db/database.js';
import { invalid, notFound, conflict } from '../lib/errors.js';
import { parseToman, parseBasisPoints } from '../lib/money.js';
import { text, int } from '../lib/validate.js';
import { VEHICLE_TYPES } from '../domain/pricing.js';
import { audit, requirePermission } from './common.js';

/** Price rows in force at `at` for one service, keyed by vehicle type. */
export function currentPrices(db, serviceId, at = nowIso()) {
  const rows = db.all(`SELECT sp.* FROM service_prices sp
    WHERE sp.service_id = :service AND sp.effective_from <= :at
      AND sp.effective_from = (SELECT max(x.effective_from) FROM service_prices x WHERE x.service_id = sp.service_id AND x.vehicle_type = sp.vehicle_type AND x.effective_from <= :at)`, { service: serviceId, at });
  return Object.fromEntries(rows.map(row => [row.vehicle_type, row]));
}

export function currentRuleSet(db, serviceId, at = nowIso()) {
  const row = db.get(`SELECT * FROM commission_rule_sets WHERE service_id = :service AND effective_from <= :at ORDER BY effective_from DESC LIMIT 1`, { service: serviceId, at });
  return row ? { ...row, rules: parseJson(row.rules, []) } : null;
}

function present(db, service) {
  const prices = currentPrices(db, service.id);
  const ruleSet = currentRuleSet(db, service.id);
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    durationMinutes: service.duration_minutes,
    checklist: parseJson(service.checklist, []),
    status: service.status,
    prices: Object.fromEntries(VEHICLE_TYPES.map(type => [type, prices[type]?.amount ?? null])),
    commission: ruleSet ? { rules: ruleSet.rules, poolLimitBp: ruleSet.pool_limit_bp, effectiveFrom: ruleSet.effective_from } : null
  };
}

export function listServices(ctx, { includeArchived = false } = {}) {
  const rows = ctx.db.all(`SELECT * FROM services WHERE business_id = :business ${includeArchived ? '' : "AND status = 'active'"} ORDER BY sort_order, name`, { business: ctx.actor.businessId });
  return rows.map(row => present(ctx.db, row));
}

/** Public catalog: only active services with at least one price; "from" = cheapest. */
export function publicCatalog(db, businessId) {
  const services = db.all(`SELECT * FROM services WHERE business_id = :business AND status = 'active' ORDER BY sort_order, name`, { business: businessId });
  const offers = db.all(`SELECT id, title, description, label FROM offers WHERE business_id = :business AND status = 'active'
    AND (starts_at IS NULL OR starts_at <= :now) AND (ends_at IS NULL OR ends_at > :now) ORDER BY created_at DESC LIMIT 6`, { business: businessId, now: nowIso() });
  return {
    services: services.map(service => {
      const amounts = Object.values(currentPrices(db, service.id)).map(row => row.amount);
      return amounts.length ? { name: service.name, description: service.description, durationMinutes: service.duration_minutes, fromPrice: Math.min(...amounts) } : null;
    }).filter(Boolean),
    offers
  };
}

/** A timestamp strictly after every existing version so versions never collide. */
function nextEffective(db, table, serviceId) {
  const latest = db.get(`SELECT max(effective_from) AS at FROM ${table} WHERE service_id = :service`, { service: serviceId })?.at;
  const now = Date.now();
  const after = latest ? Date.parse(latest) + 1 : 0;
  return new Date(Math.max(now, after)).toISOString();
}

function loadService(ctx, id) {
  const row = ctx.db.get('SELECT * FROM services WHERE id = :id AND business_id = :business', { id, business: ctx.actor.businessId });
  if (!row) throw notFound('Service');
  return row;
}

function parseChecklist(value) {
  const list = Array.isArray(value) ? value : String(value || '').split('\n');
  const items = list.map(item => text(item, 'Checklist item', { max: 80 })).filter(Boolean);
  if (items.length > 20) throw invalid('A checklist can have at most 20 items.');
  return [...new Set(items)];
}

function parseRules(rules) {
  if (!Array.isArray(rules) || !rules.length) throw invalid('Add at least one commission role.');
  if (rules.length > 8) throw invalid('A service can have at most eight commission roles.');
  return rules.map((rule, index) => ({
    role: text(rule.role, `Commission role ${index + 1}`, { required: true, max: 60 }),
    basisPoints: parseBasisPoints(rule.basisPoints, `Rate for role ${index + 1}`)
  }));
}

export function createService(ctx, input) {
  requirePermission(ctx, 'settings.manage');
  const name = text(input.name, 'Service name', { required: true, max: 80 });
  if (ctx.db.get('SELECT 1 FROM services WHERE business_id = :business AND name = :name', { business: ctx.actor.businessId, name })) throw conflict('DUPLICATE_SERVICE', 'A service with this name already exists.');
  const id = newId();
  const now = nowIso();
  ctx.db.run(`INSERT INTO services(id, business_id, name, description, duration_minutes, checklist, sort_order)
    VALUES (:id, :business, :name, :description, :duration, :checklist, :sort)`, {
    id, business: ctx.actor.businessId, name,
    description: text(input.description, 'Description', { max: 400 }),
    duration: int(input.durationMinutes ?? 30, 'Duration', { min: 5, max: 1440 }),
    checklist: JSON.stringify(parseChecklist(input.checklist)),
    sort: int(input.sortOrder ?? 0, 'Sort order', { min: 0, max: 1000 })
  });
  setPricesInternal(ctx, id, input.prices || {}, now, { requireOne: true });
  setRulesInternal(ctx, id, input.commission || { rules: [{ role: 'Main worker', basisPoints: 1000 }], poolLimitBp: 3000 }, now);
  audit(ctx, { action: 'service.created', entityType: 'service', entityId: id, after: { name } });
  return present(ctx.db, loadService(ctx, id));
}

export function updateService(ctx, id, input) {
  requirePermission(ctx, 'settings.manage');
  const service = loadService(ctx, id);
  const next = {
    description: input.description !== undefined ? text(input.description, 'Description', { max: 400 }) : service.description,
    duration: input.durationMinutes !== undefined ? int(input.durationMinutes, 'Duration', { min: 5, max: 1440 }) : service.duration_minutes,
    checklist: input.checklist !== undefined ? JSON.stringify(parseChecklist(input.checklist)) : service.checklist,
    status: input.status !== undefined ? (['active', 'archived'].includes(input.status) ? input.status : (() => { throw invalid('Status must be active or archived.'); })()) : service.status
  };
  ctx.db.run('UPDATE services SET description = :description, duration_minutes = :duration, checklist = :checklist, status = :status WHERE id = :id', { id, ...next });
  audit(ctx, { action: 'service.updated', entityType: 'service', entityId: id, before: { description: service.description, status: service.status, checklist: parseJson(service.checklist, []) }, after: { ...next, checklist: parseJson(next.checklist, []) } });
  return present(ctx.db, loadService(ctx, id));
}

function setPricesInternal(ctx, serviceId, prices, effectiveFrom, { requireOne = false } = {}) {
  let count = 0;
  for (const type of VEHICLE_TYPES) {
    const value = prices[type];
    if (value === undefined || value === null || value === '') continue;
    const amount = parseToman(value, `${type} price`, { allowZero: false });
    ctx.db.run('INSERT INTO service_prices(id, service_id, vehicle_type, amount, effective_from, created_by) VALUES (:id, :service, :type, :amount, :from, :user)', { id: newId(), service: serviceId, type, amount, from: effectiveFrom, user: ctx.actor.userId });
    count += 1;
  }
  if (requireOne && count === 0) throw invalid('Set a price for at least one vehicle type.');
  return count;
}

function setRulesInternal(ctx, serviceId, commission, effectiveFrom) {
  const rules = parseRules(commission.rules);
  const poolLimitBp = parseBasisPoints(commission.poolLimitBp, 'Pool limit');
  const total = rules.reduce((sum, rule) => sum + rule.basisPoints, 0);
  if (total > poolLimitBp) throw invalid(`The roles add up to ${(total / 100).toFixed(2)}%, above the ${(poolLimitBp / 100).toFixed(2)}% pool limit.`);
  ctx.db.run('INSERT INTO commission_rule_sets(id, service_id, rules, pool_limit_bp, effective_from, created_by) VALUES (:id, :service, :rules, :limit, :from, :user)', { id: newId(), service: serviceId, rules: JSON.stringify(rules), limit: poolLimitBp, from: effectiveFrom, user: ctx.actor.userId });
}

/** New price version effective immediately; history and existing job snapshots are untouched. */
export function setPrices(ctx, serviceId, prices) {
  requirePermission(ctx, 'settings.manage');
  loadService(ctx, serviceId);
  const before = currentPrices(ctx.db, serviceId);
  const count = setPricesInternal(ctx, serviceId, prices || {}, nextEffective(ctx.db, 'service_prices', serviceId));
  if (!count) throw invalid('Enter at least one new price.');
  audit(ctx, { action: 'service.prices_versioned', entityType: 'service', entityId: serviceId, before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.amount])), after: prices });
  return present(ctx.db, loadService(ctx, serviceId));
}

export function setCommissionRules(ctx, serviceId, commission) {
  requirePermission(ctx, 'settings.manage');
  loadService(ctx, serviceId);
  const before = currentRuleSet(ctx.db, serviceId);
  setRulesInternal(ctx, serviceId, commission || {}, nextEffective(ctx.db, 'commission_rule_sets', serviceId));
  audit(ctx, { action: 'service.commission_versioned', entityType: 'service', entityId: serviceId, before: before && { rules: before.rules, poolLimitBp: before.pool_limit_bp }, after: commission });
  return present(ctx.db, loadService(ctx, serviceId));
}
