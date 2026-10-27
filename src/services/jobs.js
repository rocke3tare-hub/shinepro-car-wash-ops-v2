import { newId, parseJson } from '../db/database.js';
import { AppError, forbidden, invalid, notFound } from '../lib/errors.js';
import { parseToman } from '../lib/money.js';
import { text, phone, oneOf, id as idField, bool } from '../lib/validate.js';
import { quote, commissionFor, assertPoolLimit, commissionBreakdown, VEHICLE_TYPES, VEHICLE_LABELS } from '../domain/pricing.js';
import { JOB_ACTIONS, EDITABLE_STATES, STATUS_LABELS, ASSIGNMENT_STATUS_ON, nextStatus, guard, availableActions } from '../domain/jobs.js';
import { can, isOwnJobsOnly } from '../domain/permissions.js';
import { audit, branchFilter, expectVersion, nextCounter, requireBranch, requirePermission, requireAnyPermission, settings } from './common.js';
import { currentPrices, currentRuleSet } from './catalog.js';
import { normalizePlate } from './customers.js';

const SUMMARY_COLUMNS = 'j.id, j.code, j.branch_id, j.plate, j.vehicle_type, j.vehicle_label, j.customer_name, j.service_name, j.final_price, j.status, j.payment_status, j.discount_status, j.bay, j.created_at, j.version';

function activeAssignments(db, jobId) {
  return db.all(`SELECT a.*, w.name AS worker_name, w.user_id AS worker_user_id FROM job_assignments a JOIN workers w ON w.id = a.worker_id
    WHERE a.job_id = :job AND a.status <> 'removed' ORDER BY a.created_at`, { job: jobId });
}

/** Load a job inside the actor's business and branch scope; worker-only actors must be assigned. */
export function loadJob(ctx, jobId) {
  const job = ctx.db.get('SELECT * FROM jobs WHERE id = :id AND business_id = :business', { id: jobId, business: ctx.actor.businessId });
  if (!job) throw notFound('Job');
  requireBranch(ctx, job.branch_id);
  if (isOwnJobsOnly(ctx.actor)) {
    const mine = ctx.actor.workerId && ctx.db.get(`SELECT 1 FROM job_assignments WHERE job_id = :job AND worker_id = :worker AND status <> 'removed'`, { job: jobId, worker: ctx.actor.workerId });
    if (!mine) throw notFound('Job');
  }
  return job;
}

export function listJobs(ctx, { status = '', q = '', branchId = '', limit = 100 } = {}) {
  requireAnyPermission(ctx, ['jobs.view', 'jobs.view_own']);
  const scope = branchFilter(ctx, 'j.branch_id');
  const params = { business: ctx.actor.businessId, ...scope.params };
  const where = ['j.business_id = :business', scope.sql];
  if (isOwnJobsOnly(ctx.actor)) {
    params.worker = ctx.actor.workerId || '';
    where.push(`EXISTS (SELECT 1 FROM job_assignments a WHERE a.job_id = j.id AND a.worker_id = :worker AND a.status <> 'removed')`);
  }
  if (status === 'open') where.push(`j.status NOT IN ('completed','cancelled','refunded')`);
  else if (status) { params.status = oneOf(status, Object.keys(STATUS_LABELS), 'Status'); where.push('j.status = :status'); }
  if (branchId) { params.branch = idField(branchId, 'Branch'); where.push('j.branch_id = :branch'); }
  if (q) {
    params.q = `%${String(q).slice(0, 60).replace(/[%_\\]/g, ch => `\\${ch}`)}%`;
    where.push(`(j.code LIKE :q ESCAPE '\\' OR j.plate LIKE :q ESCAPE '\\' OR j.customer_name LIKE :q ESCAPE '\\' OR j.service_name LIKE :q ESCAPE '\\')`);
  }
  params.limit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = ctx.db.all(`SELECT ${SUMMARY_COLUMNS} FROM jobs j WHERE ${where.join(' AND ')} ORDER BY j.created_at DESC LIMIT :limit`, params);
  const names = ctx.db.all(`SELECT a.job_id, w.name FROM job_assignments a JOIN workers w ON w.id = a.worker_id WHERE a.status <> 'removed' AND a.job_id IN (SELECT j.id FROM jobs j WHERE ${where.join(' AND ')} ORDER BY j.created_at DESC LIMIT :limit)`, params);
  const byJob = new Map();
  for (const row of names) byJob.set(row.job_id, [...(byJob.get(row.job_id) || []), row.name]);
  return rows.map(row => ({ ...camelJob(row), workers: byJob.get(row.id) || [] }));
}

function camelJob(row) {
  return {
    id: row.id, code: row.code, branchId: row.branch_id, plate: row.plate, vehicleType: row.vehicle_type, vehicleLabel: row.vehicle_label,
    customerName: row.customer_name, serviceName: row.service_name, finalPrice: row.final_price, status: row.status, statusLabel: STATUS_LABELS[row.status],
    paymentStatus: row.payment_status, discountStatus: row.discount_status, bay: row.bay, createdAt: row.created_at, version: row.version
  };
}

export function getJob(ctx, jobId) {
  requireAnyPermission(ctx, ['jobs.view', 'jobs.view_own']);
  const job = loadJob(ctx, jobId);
  const assignments = activeAssignments(ctx.db, jobId);
  const breakdown = commissionBreakdown(job.final_price, assignments);
  const checklist = parseJson(job.checklist, []);
  const payment = ctx.db.get(`SELECT * FROM payments WHERE job_id = :job ORDER BY created_at DESC LIMIT 1`, { job: jobId });
  const parts = payment ? ctx.db.all('SELECT method, amount, reference FROM payment_parts WHERE payment_id = :id', { id: payment.id }) : [];
  const refunds = ctx.db.all('SELECT id, amount, method, reason, status, created_at FROM refunds WHERE job_id = :job ORDER BY created_at', { job: jobId });
  const quality = ctx.db.all(`SELECT q.outcome, q.results, q.notes, q.created_at, u.display_name AS inspector FROM quality_checks q JOIN users u ON u.id = q.inspector_user_id WHERE q.job_id = :job ORDER BY q.created_at`, { job: jobId })
    .map(row => ({ ...row, results: parseJson(row.results, []) }));
  const approvals = ctx.db.all(`SELECT id, kind, amount, reason, status, decision_note, created_at FROM approvals WHERE subject_type = 'job' AND subject_id = :job ORDER BY created_at`, { job: jobId });
  const history = can(ctx.actor, 'audit.view') || can(ctx.actor, 'jobs.view')
    ? ctx.db.all(`SELECT a.action, a.reason, a.created_at, u.display_name AS actor FROM audit_events a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity_type = 'job' AND a.entity_id = :job ORDER BY a.id`, { job: jobId })
    : [];
  const canSeeMoney = can(ctx.actor, 'jobs.view');
  const showCommissionFor = row => canSeeMoney || row.worker_id === ctx.actor.workerId;
  const context = { assignments, actorWorkerId: ctx.actor.workerId, checklistComplete: true };
  const actions = availableActions(job, ctx.actor, context)
    .filter(a => !(isOwnJobsOnly(ctx.actor) && a.action !== 'start' && a.action !== 'pause' && a.action !== 'submit_for_quality'));
  const paidAmount = payment && payment.status !== 'refunded' ? payment.amount : 0;
  const refunded = refunds.filter(r => r.status === 'approved').reduce((s, r) => s + r.amount, 0);

  return {
    ...camelJob(job),
    customerId: job.customer_id,
    vehicleId: job.vehicle_id,
    customerPhone: canSeeMoney ? job.customer_phone : null,
    serviceId: job.service_id,
    originalPrice: job.original_price,
    discount: job.discount,
    discountReason: job.discount_reason,
    notes: job.notes,
    existingDamage: job.existing_damage,
    cancelReason: job.cancel_reason,
    checklist,
    completedAt: job.completed_at,
    assignments: breakdown.rows.map(row => ({
      id: row.id, workerId: row.worker_id, workerName: row.worker_name, role: row.role_label, commissionType: row.commission_type,
      basisPoints: row.basis_points, fixedAmount: row.fixed_amount, status: row.status, amount: showCommissionFor(row) ? row.amount : null
    })),
    commissionTotal: canSeeMoney ? breakdown.total : null,
    payment: payment && canSeeMoney ? { id: payment.id, amount: payment.amount, tipAmount: payment.tip_amount, tipMethod: payment.tip_method, status: payment.status, createdAt: payment.created_at, parts } : null,
    refundable: canSeeMoney && payment && job.payment_status === 'paid' ? Math.max(0, paidAmount - refunded) : 0,
    refunds: canSeeMoney ? refunds : [],
    quality,
    approvals: canSeeMoney ? approvals : [],
    history,
    actions,
    editable: EDITABLE_STATES.includes(job.status) && can(ctx.actor, 'jobs.edit'),
    canAssign: EDITABLE_STATES.includes(job.status) && job.status !== 'ready_for_quality' && can(ctx.actor, 'jobs.assign'),
    canTakePayment: job.status === 'ready_for_payment' && job.payment_status === 'unpaid' && job.discount_status !== 'pending' && can(ctx.actor, 'payments.create'),
    canRequestRefund: job.payment_status === 'paid' && can(ctx.actor, 'refunds.request') && !refunds.some(r => r.status === 'pending')
  };
}

/** Price preview for the new-job form. */
export function quoteJob(ctx, input) {
  requirePermission(ctx, 'jobs.create');
  const service = loadService(ctx, input.serviceId);
  const vehicleType = oneOf(input.vehicleType, VEHICLE_TYPES, 'Vehicle type');
  const prices = currentPrices(ctx.db, service.id);
  const q = quote(prices[vehicleType], parseToman(input.discount ?? 0, 'Discount'), settings(ctx).discountApprovalBp);
  const ruleSet = currentRuleSet(ctx.db, service.id);
  return { ...q, serviceName: service.name, rules: ruleSet?.rules ?? [], poolLimitBp: ruleSet?.pool_limit_bp ?? 0 };
}

function loadService(ctx, serviceId) {
  const service = ctx.db.get(`SELECT * FROM services WHERE id = :id AND business_id = :business AND status = 'active'`, { id: idField(serviceId, 'Service'), business: ctx.actor.businessId });
  if (!service) throw notFound('Service');
  return service;
}

function resolveBranch(ctx, branchId) {
  if (branchId) {
    const id = idField(branchId, 'Branch');
    const branch = ctx.db.get(`SELECT * FROM branches WHERE id = :id AND business_id = :business AND status = 'active'`, { id, business: ctx.actor.businessId });
    if (!branch) throw notFound('Branch');
    requireBranch(ctx, branch.id);
    return branch;
  }
  const scope = branchFilter(ctx, 'id');
  const branches = ctx.db.all(`SELECT * FROM branches WHERE business_id = :business AND status = 'active' AND ${scope.sql} ORDER BY created_at`, { business: ctx.actor.businessId, ...scope.params });
  if (branches.length !== 1) throw invalid('Choose the branch for this job.', { field: 'branchId' });
  return branches[0];
}

/**
 * Validate requested assignments [{ workerId, role }] against the job's rule set.
 * Each role comes from the service's commission rules so the rate is never typed by hand.
 */
function buildAssignments(ctx, job, ruleSet, requested) {
  if (!Array.isArray(requested)) throw invalid('Assignments must be a list.');
  if (requested.length > 8) throw invalid('At most eight workers can be assigned to one job.');
  const rules = ruleSet?.rules ?? [];
  const seenWorkers = new Set();
  const rows = requested.map((item, index) => {
    const workerId = idField(item.workerId, `Worker ${index + 1}`);
    if (seenWorkers.has(workerId)) throw invalid('A worker can only be assigned once per job.');
    seenWorkers.add(workerId);
    const worker = ctx.db.get(`SELECT * FROM workers WHERE id = :id AND business_id = :business AND status = 'active'`, { id: workerId, business: ctx.actor.businessId });
    if (!worker) throw notFound('Worker');
    if (worker.branch_id !== job.branch_id) throw invalid(`${worker.name} works at another branch.`);
    const role = text(item.role, 'Assignment role', { required: true, max: 60 });
    const rule = rules.find(r => r.role === role);
    if (!rule) throw invalid(`"${role}" is not a commission role for ${job.service_name}.`);
    return { worker_id: workerId, role_label: role, commission_type: 'percentage', basis_points: rule.basisPoints, fixed_amount: 0, worker_name: worker.name };
  });
  const roleCounts = new Map();
  for (const row of rows) roleCounts.set(row.role_label, (roleCounts.get(row.role_label) || 0) + 1);
  for (const [role, count] of roleCounts) if (count > 1) throw invalid(`The role "${role}" is assigned more than once.`);
  if (ruleSet) assertPoolLimit(job.final_price, rows, ruleSet.pool_limit_bp);
  return rows;
}

function insertAssignments(ctx, jobId, rows) {
  for (const row of rows) {
    ctx.db.run(`INSERT INTO job_assignments(id, job_id, worker_id, role_label, commission_type, basis_points, fixed_amount) VALUES (:id, :job, :worker, :role, :type, :bp, :fixed)`,
      { id: newId(), job: jobId, worker: row.worker_id, role: row.role_label, type: row.commission_type, bp: row.basis_points, fixed: row.fixed_amount });
  }
}

function createDiscountApproval(ctx, job, reason) {
  ctx.db.run(`INSERT INTO approvals(id, business_id, branch_id, kind, subject_type, subject_id, amount, reason, payload, requested_by)
    VALUES (:id, :business, :branch, 'discount', 'job', :job, :amount, :reason, :payload, :user)`, {
    id: newId(), business: ctx.actor.businessId, branch: job.branch_id, job: job.id, amount: job.discount,
    reason, payload: JSON.stringify({ code: job.code, originalPrice: job.original_price, discount: job.discount }), user: ctx.actor.userId
  });
}

export function createJob(ctx, input) {
  requirePermission(ctx, 'jobs.create');
  const branch = resolveBranch(ctx, input.branchId);
  const service = loadService(ctx, input.serviceId);
  const vehicleType = oneOf(input.vehicleType, VEHICLE_TYPES, 'Vehicle type');
  const plate = normalizePlate(input.plate);
  const config = settings(ctx);
  const prices = currentPrices(ctx.db, service.id);
  const discount = parseToman(input.discount ?? 0, 'Discount');
  const q = quote(prices[vehicleType], discount, config.discountApprovalBp);
  const discountReason = text(input.discountReason, 'Discount reason', { max: 200 });
  if (discount > 0 && !discountReason) throw invalid('Give a reason for the discount.', { field: 'discountReason' });

  // Link to a known vehicle/customer when possible; a walk-in stays a snapshot only.
  const vehicle = ctx.db.get('SELECT * FROM vehicles WHERE business_id = :business AND plate = :plate', { business: ctx.actor.businessId, plate });
  let customer = null;
  if (input.customerId) {
    customer = ctx.db.get(`SELECT * FROM customers WHERE id = :id AND business_id = :business AND status = 'active'`, { id: idField(input.customerId, 'Customer'), business: ctx.actor.businessId });
    if (!customer) throw notFound('Customer');
  } else if (vehicle?.customer_id) {
    customer = ctx.db.get('SELECT * FROM customers WHERE id = :id', { id: vehicle.customer_id });
  }
  const customerName = customer?.name || text(input.customerName, 'Customer name', { max: 120 }) || 'Walk-in customer';
  const customerPhone = customer?.phone || phone(input.customerPhone);
  const label = [text(input.brand, 'Brand', { max: 40 }) || vehicle?.brand, text(input.model, 'Model', { max: 40 }) || vehicle?.model].filter(Boolean).join(' ') || null;
  const bays = parseJson(branch.bays, []);
  const bay = input.bay ? oneOf(input.bay, bays, 'Bay') : null;
  const ruleSet = currentRuleSet(ctx.db, service.id);

  const id = newId();
  const sequence = nextCounter(ctx, `job:${new Date().getUTCFullYear()}`);
  const code = `${config.jobCodePrefix}-${new Date().getUTCFullYear()}-${String(sequence).padStart(6, '0')}`;
  const job = {
    id, business_id: ctx.actor.businessId, branch_id: branch.id, code, customer_id: customer?.id ?? null, vehicle_id: vehicle?.id ?? null,
    plate, vehicle_type: vehicleType, vehicle_label: label, customer_name: customerName, customer_phone: customerPhone,
    service_id: service.id, service_name: service.name, price_snapshot_id: prices[vehicleType].id, rule_set_id: ruleSet?.id ?? null,
    original_price: q.originalPrice, discount: q.discount, discount_reason: discountReason,
    discount_status: q.discount === 0 ? 'none' : (q.discountNeedsApproval ? 'pending' : 'approved'),
    final_price: q.finalPrice, status: 'waiting', bay, notes: text(input.notes, 'Notes', { max: 500 }),
    existing_damage: text(input.existingDamage, 'Existing damage', { max: 500 }), checklist: service.checklist, created_by: ctx.actor.userId
  };
  const assignments = input.assignments?.length ? buildAssignments(ctx, job, ruleSet, input.assignments) : [];
  if (assignments.length && !can(ctx.actor, 'jobs.assign')) throw forbidden('You cannot assign workers.');
  if (assignments.length) job.status = 'assigned';

  ctx.db.run(`INSERT INTO jobs(id, business_id, branch_id, code, customer_id, vehicle_id, plate, vehicle_type, vehicle_label, customer_name, customer_phone,
      service_id, service_name, price_snapshot_id, rule_set_id, original_price, discount, discount_reason, discount_status, final_price, status, bay, notes, existing_damage, checklist, created_by)
    VALUES (:id, :business_id, :branch_id, :code, :customer_id, :vehicle_id, :plate, :vehicle_type, :vehicle_label, :customer_name, :customer_phone,
      :service_id, :service_name, :price_snapshot_id, :rule_set_id, :original_price, :discount, :discount_reason, :discount_status, :final_price, :status, :bay, :notes, :existing_damage, :checklist, :created_by)`, job);
  insertAssignments(ctx, id, assignments);
  if (job.discount_status === 'pending') createDiscountApproval(ctx, job, discountReason);
  audit(ctx, { action: 'job.created', entityType: 'job', entityId: id, branchId: branch.id, after: { code, service: service.name, plate, originalPrice: q.originalPrice, discount: q.discount, finalPrice: q.finalPrice, discountStatus: job.discount_status, workers: assignments.map(a => a.worker_name) } });
  return getJob(ctx, id);
}

export function updateJob(ctx, jobId, input) {
  requirePermission(ctx, 'jobs.edit');
  const job = loadJob(ctx, jobId);
  expectVersion(job, input.expectedVersion, 'job');
  if (!EDITABLE_STATES.includes(job.status)) throw new AppError('JOB_LOCKED', 'This job is locked. Completed records change only through refunds or corrections.', 422);
  const branch = ctx.db.get('SELECT bays FROM branches WHERE id = :id', { id: job.branch_id });
  const next = {
    bay: input.bay !== undefined ? (input.bay ? oneOf(input.bay, parseJson(branch.bays, []), 'Bay') : null) : job.bay,
    notes: input.notes !== undefined ? text(input.notes, 'Notes', { max: 500 }) : job.notes,
    existingDamage: input.existingDamage !== undefined ? text(input.existingDamage, 'Existing damage', { max: 500 }) : job.existing_damage
  };
  ctx.db.run(`UPDATE jobs SET bay = :bay, notes = :notes, existing_damage = :existingDamage, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: jobId, ...next });
  audit(ctx, { action: 'job.edited', entityType: 'job', entityId: jobId, branchId: job.branch_id, before: { bay: job.bay, notes: job.notes, existingDamage: job.existing_damage }, after: next });
  return getJob(ctx, jobId);
}

/** Change the discount before payment; re-evaluates approval and commission base. */
export function changeDiscount(ctx, jobId, input) {
  requirePermission(ctx, 'jobs.edit');
  const job = loadJob(ctx, jobId);
  expectVersion(job, input.expectedVersion, 'job');
  if (job.payment_status !== 'unpaid' || ['completed', 'cancelled', 'refunded'].includes(job.status)) throw new AppError('JOB_LOCKED', 'The discount can no longer be changed.', 422);
  const discount = parseToman(input.discount, 'Discount');
  const reason = text(input.discountReason, 'Discount reason', { max: 200 });
  if (discount > 0 && !reason) throw invalid('Give a reason for the discount.', { field: 'discountReason' });
  const q = quote({ amount: job.original_price }, discount, settings(ctx).discountApprovalBp);
  const ruleSet = job.rule_set_id ? ctx.db.get('SELECT * FROM commission_rule_sets WHERE id = :id', { id: job.rule_set_id }) : null;
  if (ruleSet) assertPoolLimit(q.finalPrice, activeAssignments(ctx.db, jobId), ruleSet.pool_limit_bp);
  const status = discount === 0 ? 'none' : (q.discountNeedsApproval ? 'pending' : 'approved');
  ctx.db.run(`UPDATE approvals SET status = 'withdrawn', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = :user, decision_note = 'Superseded by a new discount' WHERE kind = 'discount' AND subject_id = :job AND status = 'pending'`, { job: jobId, user: ctx.actor.userId });
  ctx.db.run(`UPDATE jobs SET discount = :discount, discount_reason = :reason, discount_status = :status, final_price = :final, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`,
    { id: jobId, discount, reason, status, final: q.finalPrice });
  if (status === 'pending') createDiscountApproval(ctx, { ...job, discount }, reason);
  audit(ctx, { action: 'job.discount_changed', entityType: 'job', entityId: jobId, branchId: job.branch_id, before: { discount: job.discount, finalPrice: job.final_price }, after: { discount, finalPrice: q.finalPrice, discountStatus: status }, reason });
  return getJob(ctx, jobId);
}

export function setAssignments(ctx, jobId, input) {
  requirePermission(ctx, 'jobs.assign');
  const job = loadJob(ctx, jobId);
  expectVersion(job, input.expectedVersion, 'job');
  if (!['waiting', 'assigned', 'in_progress', 'paused', 'rework_required'].includes(job.status)) throw new AppError('JOB_LOCKED', 'Assignments are locked once the job is submitted for quality.', 422);
  const ruleSet = job.rule_set_id ? { ...ctx.db.get('SELECT * FROM commission_rule_sets WHERE id = :id', { id: job.rule_set_id }) } : null;
  if (ruleSet) ruleSet.rules = parseJson(ruleSet.rules, []);
  const rows = buildAssignments(ctx, job, ruleSet, input.assignments || []);
  if (!rows.length && !['waiting', 'assigned'].includes(job.status)) throw invalid('A job in progress needs at least one worker.');
  const before = activeAssignments(ctx.db, jobId);
  const keep = new Map(before.map(a => [`${a.worker_id}|${a.role_label}`, a]));
  // Keep unchanged rows (and their progress); remove the rest; insert new ones.
  const incoming = new Set(rows.map(r => `${r.worker_id}|${r.role_label}`));
  for (const old of before) if (!incoming.has(`${old.worker_id}|${old.role_label}`)) ctx.db.run(`UPDATE job_assignments SET status = 'removed' WHERE id = :id`, { id: old.id });
  const startedStatus = ['in_progress', 'paused'].includes(job.status) ? 'started' : 'assigned';
  for (const row of rows) {
    if (keep.has(`${row.worker_id}|${row.role_label}`)) continue;
    ctx.db.run(`INSERT INTO job_assignments(id, job_id, worker_id, role_label, commission_type, basis_points, fixed_amount, status) VALUES (:id, :job, :worker, :role, :type, :bp, :fixed, :status)`,
      { id: newId(), job: jobId, worker: row.worker_id, role: row.role_label, type: row.commission_type, bp: row.basis_points, fixed: row.fixed_amount, status: startedStatus });
  }
  let status = job.status;
  if (status === 'waiting' && rows.length) status = 'assigned';
  if (status === 'assigned' && !rows.length) status = 'waiting';
  ctx.db.run(`UPDATE jobs SET status = :status, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: jobId, status });
  audit(ctx, { action: 'job.assignments_changed', entityType: 'job', entityId: jobId, branchId: job.branch_id, before: before.map(a => `${a.worker_name} · ${a.role_label}`), after: rows.map(a => `${a.worker_name} · ${a.role_label}`) });
  return getJob(ctx, jobId);
}

export function transitionJob(ctx, jobId, action, input = {}) {
  const rule = JOB_ACTIONS[action];
  if (!rule) throw new AppError('UNKNOWN_ACTION', `Unknown job action: ${action}.`, 422);
  requirePermission(ctx, rule.permission);
  const job = loadJob(ctx, jobId);
  expectVersion(job, input.expectedVersion, 'job');
  const to = nextStatus(job, action);
  const assignments = activeAssignments(ctx.db, jobId);

  if (isOwnJobsOnly(ctx.actor) && !['start', 'pause', 'submit_for_quality'].includes(action)) throw forbidden();
  let checklistComplete = true;
  let results = [];
  let reason = null;
  if (action === 'approve_quality' || action === 'request_rework') {
    const checklist = parseJson(job.checklist, []);
    const submitted = Array.isArray(input.results) ? input.results : [];
    results = checklist.map(item => ({ item, passed: bool(submitted.find(r => r?.item === item)?.passed) }));
    checklistComplete = results.every(r => r.passed);
  }
  if (action === 'request_rework' || action === 'cancel' || action === 'pause') {
    reason = text(input.reason, 'Reason', { required: action !== 'pause', max: 300 });
  }
  const blocked = guard(job, action, { assignments, actorWorkerId: ctx.actor.workerId, checklistComplete });
  if (blocked) throw new AppError('ACTION_BLOCKED', blocked, 422);

  ctx.db.run(`UPDATE jobs SET status = :to, cancel_reason = CASE WHEN :to = 'cancelled' THEN :reason ELSE cancel_reason END, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id AND version = :version`,
    { id: jobId, to, reason, version: job.version });
  const step = ASSIGNMENT_STATUS_ON[action];
  if (step) {
    for (const a of assignments) if (step.from.includes(a.status)) ctx.db.run('UPDATE job_assignments SET status = :status WHERE id = :id', { id: a.id, status: step.to });
  }
  if (action === 'approve_quality' || action === 'request_rework') {
    ctx.db.run('INSERT INTO quality_checks(id, job_id, inspector_user_id, outcome, results, notes) VALUES (:id, :job, :user, :outcome, :results, :notes)',
      { id: newId(), job: jobId, user: ctx.actor.userId, outcome: action === 'approve_quality' ? 'passed' : 'rework', results: JSON.stringify(results), notes: reason || text(input.notes, 'Notes', { max: 300 }) });
  }
  if (action === 'cancel') {
    ctx.db.run(`UPDATE approvals SET status = 'withdrawn', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = :user, decision_note = 'Job cancelled' WHERE subject_type = 'job' AND subject_id = :job AND status = 'pending'`, { job: jobId, user: ctx.actor.userId });
  }
  audit(ctx, { action: `job.${action}`, entityType: 'job', entityId: jobId, branchId: job.branch_id, before: { status: job.status }, after: { status: to }, reason });
  return getJob(ctx, jobId);
}

export { VEHICLE_LABELS, commissionFor };
