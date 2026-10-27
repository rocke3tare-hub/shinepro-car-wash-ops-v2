import { AppError } from '../lib/errors.js';
import { id as idField } from '../lib/validate.js';
import { ROLE_LABELS } from '../domain/permissions.js';
import { STATUS_LABELS } from '../domain/jobs.js';
import { VEHICLE_LABELS, VEHICLE_TYPES } from '../domain/pricing.js';
import * as auth from '../services/auth.js';
import * as catalog from '../services/catalog.js';
import * as customers from '../services/customers.js';
import * as workers from '../services/workers.js';
import * as jobs from '../services/jobs.js';
import * as payments from '../services/payments.js';
import * as approvals from '../services/approvals.js';
import * as cash from '../services/cash.js';
import * as expenses from '../services/expenses.js';
import * as earnings from '../services/earnings.js';
import * as inventory from '../services/inventory.js';
import * as reports from '../services/reports.js';
import * as admin from '../services/admin.js';
import * as publicSite from '../services/public.js';
import { settings } from '../services/common.js';

/**
 * Route table. Each handler receives { ctx, body, query, params, request } and
 * returns { status?, data } | { file } | { cookie, data }. Mutating handlers
 * run inside one database transaction (see server.js), so a failure anywhere
 * rolls back every write of that request.
 */
const routes = [];
const route = (method, pattern, handler, { auth: needsAuth = true, tx = method !== 'GET', limiter = null } = {}) => {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; })}$`);
  routes.push({ method, regex, keys, handler, needsAuth, tx, limiter });
};

const uuid = (params, key = 'id') => idField(params[key], key);

// ---- Public ----
route('GET', '/api/health', ({ config }) => ({ data: { status: 'ok', label: config.label, environment: config.env, payments: config.paymentsMode } }), { auth: false });
route('GET', '/api/public/catalog', ({ db, config }) => ({ data: catalog.publicCatalog(db, publicSite.publicBusinessId(db, config)) }), { auth: false });
route('POST', '/api/auth/signup', ({ db, config, body }) => {
  const result = publicSite.signup(db, config, body);
  return { status: 201, cookie: result.token, data: { signedUp: true } };
}, { auth: false, tx: false, limiter: 'signup' });
route('POST', '/api/auth/login', ({ db, config, body, ip }) => {
  const result = auth.login(db, config, { email: body.email, password: body.password, ip });
  const actor = auth.actorFromToken(db, result.token);
  return { cookie: result.token, data: { destination: actor?.permissions.includes('portal.self') && actor.roles.length === 1 ? '/portal' : '/app' } };
}, { auth: false, tx: false });
route('POST', '/api/auth/logout', ({ db, token }) => { auth.revokeSession(db, token); return { cookie: '', data: { signedOut: true } }; }, { auth: false });
route('POST', '/api/business-registrations', ({ db, body }) => ({ status: 201, data: publicSite.registerBusiness(db, body) }), { auth: false, limiter: 'registration' });

// ---- Session ----
route('GET', '/api/me', ({ ctx }) => ({
  data: {
    user: { id: ctx.actor.userId, email: ctx.actor.email, displayName: ctx.actor.displayName, workerId: ctx.actor.workerId, customerId: ctx.actor.customerId },
    roles: ctx.actor.roles.map(role => ({ role, label: ROLE_LABELS[role] })),
    permissions: ctx.actor.permissions,
    branches: admin.listBranches(ctx),
    settings: settings(ctx),
    labels: { status: STATUS_LABELS, vehicle: VEHICLE_LABELS, vehicleTypes: VEHICLE_TYPES, categories: expenses.CATEGORY_LABELS }
  }
}));
route('POST', '/api/auth/password', ({ ctx, config, body }) => { admin.changePassword(ctx, config, body, auth.verifyPassword); return { cookie: '', data: { changed: true } }; });

// ---- Catalog & settings ----
route('GET', '/api/services', ({ ctx, query }) => ({ data: catalog.listServices(ctx, { includeArchived: query.get('all') === '1' }) }));
route('POST', '/api/services', ({ ctx, body }) => ({ status: 201, data: catalog.createService(ctx, body) }));
route('PATCH', '/api/services/:id', ({ ctx, params, body }) => ({ data: catalog.updateService(ctx, uuid(params), body) }));
route('POST', '/api/services/:id/prices', ({ ctx, params, body }) => ({ data: catalog.setPrices(ctx, uuid(params), body.prices) }));
route('POST', '/api/services/:id/commission', ({ ctx, params, body }) => ({ data: catalog.setCommissionRules(ctx, uuid(params), body) }));
route('GET', '/api/settings', ({ ctx }) => ({ data: admin.getSettings(ctx) }));
route('PATCH', '/api/settings', ({ ctx, body }) => ({ data: admin.updateSettings(ctx, body) }));
route('GET', '/api/branches', ({ ctx }) => ({ data: admin.listBranches(ctx) }));

// ---- Workers & staff ----
route('GET', '/api/workers', ({ ctx, query }) => ({ data: workers.listWorkers(ctx, { includeSuspended: query.get('all') === '1' }) }));
route('POST', '/api/workers', ({ ctx, body }) => ({ status: 201, data: workers.createWorker(ctx, body) }));
route('PATCH', '/api/workers/:id', ({ ctx, params, body }) => ({ data: workers.updateWorker(ctx, uuid(params), body) }));
route('GET', '/api/staff', ({ ctx }) => ({ data: admin.listStaff(ctx) }));
route('POST', '/api/staff', ({ ctx, config, body }) => ({ status: 201, data: admin.createStaff(ctx, config, body) }));
route('DELETE', '/api/staff/roles/:id', ({ ctx, params }) => ({ data: admin.revokeRole(ctx, uuid(params)) }));

// ---- Jobs ----
route('GET', '/api/jobs', ({ ctx, query }) => ({ data: jobs.listJobs(ctx, { status: query.get('status') || '', q: query.get('q') || '', branchId: query.get('branchId') || '', limit: query.get('limit') }) }));
route('POST', '/api/jobs/quote', ({ ctx, body }) => ({ data: jobs.quoteJob(ctx, body) }), { tx: false });
route('POST', '/api/jobs', ({ ctx, body }) => ({ status: 201, data: jobs.createJob(ctx, body) }));
route('GET', '/api/jobs/:id', ({ ctx, params }) => ({ data: jobs.getJob(ctx, uuid(params)) }));
route('PATCH', '/api/jobs/:id', ({ ctx, params, body }) => ({ data: jobs.updateJob(ctx, uuid(params), body) }));
route('POST', '/api/jobs/:id/discount', ({ ctx, params, body }) => ({ data: jobs.changeDiscount(ctx, uuid(params), body) }));
route('PUT', '/api/jobs/:id/assignments', ({ ctx, params, body }) => ({ data: jobs.setAssignments(ctx, uuid(params), body) }));
route('POST', '/api/jobs/:id/actions/:action', ({ ctx, params, body }) => {
  if (!/^[a-z_]{1,40}$/.test(params.action)) throw new AppError('UNKNOWN_ACTION', 'Unknown job action.', 422);
  return { data: jobs.transitionJob(ctx, uuid(params), params.action, body) };
});
route('POST', '/api/jobs/:id/payments', ({ ctx, params, body, request }) => {
  const result = payments.takePayment(ctx, uuid(params), body, request.headers['idempotency-key']);
  return { status: result.duplicate ? 200 : 201, data: result };
});
route('POST', '/api/jobs/:id/refunds', ({ ctx, params, body }) => ({ status: 201, data: payments.requestRefund(ctx, uuid(params), body) }));
route('GET', '/api/jobs/:id/receipt', ({ ctx, params }) => {
  const job = jobs.getJob(ctx, uuid(params));
  const branch = ctx.db.get('SELECT b.name AS branch, bu.name AS business FROM branches b JOIN businesses bu ON bu.id = b.business_id WHERE b.id = :id', { id: job.branchId });
  const phone = job.customerPhone ? `${job.customerPhone.slice(0, 4)} •••• ${job.customerPhone.slice(-3)}` : null;
  return { data: { ...job, customerPhone: phone, history: undefined, approvals: undefined, assignments: undefined, business: branch.business, branchName: branch.branch } };
});

// ---- Customers & vehicles ----
route('GET', '/api/customers', ({ ctx, query }) => ({ data: customers.listCustomers(ctx, { q: query.get('q') || '', type: query.get('type') || '' }) }));
route('POST', '/api/customers', ({ ctx, body }) => ({ status: 201, data: customers.createCustomer(ctx, body) }));
route('GET', '/api/customers/:id', ({ ctx, params }) => ({ data: customers.getCustomer(ctx, uuid(params)) }));
route('PATCH', '/api/customers/:id', ({ ctx, params, body }) => ({ data: customers.updateCustomer(ctx, uuid(params), body) }));
route('POST', '/api/customers/:id/credit-limit', ({ ctx, params, body }) => ({ data: customers.setCreditLimit(ctx, uuid(params), body) }));
route('GET', '/api/vehicles/lookup', ({ ctx, query }) => ({ data: customers.findVehicleByPlate(ctx, query.get('plate') || '') }));
route('POST', '/api/vehicles', ({ ctx, body }) => ({ status: 201, data: customers.createVehicle(ctx, body) }));
route('PATCH', '/api/vehicles/:id', ({ ctx, params, body }) => ({ data: customers.updateVehicle(ctx, uuid(params), body) }));

// ---- Approvals, cash, expenses, earnings ----
route('GET', '/api/approvals', ({ ctx, query }) => ({ data: approvals.listApprovals(ctx, { status: query.get('status') || 'pending' }) }));
route('POST', '/api/approvals/:id/decision', ({ ctx, params, body }) => ({ data: approvals.decideApproval(ctx, uuid(params), body) }));
route('GET', '/api/cash', ({ ctx, query }) => ({ data: cash.cashOverview(ctx, query.get('branchId')) }));
route('POST', '/api/cash/open', ({ ctx, body }) => ({ data: cash.openRegister(ctx, body.branchId, body) }));
route('POST', '/api/cash/movements', ({ ctx, body }) => ({ data: cash.moveCash(ctx, body.branchId, body) }));
route('POST', '/api/cash/close', ({ ctx, body }) => ({ data: cash.closeRegister(ctx, body.branchId, body) }));
route('GET', '/api/expenses', ({ ctx, query }) => ({ data: expenses.listExpenses(ctx, { status: query.get('status') || '' }) }));
route('POST', '/api/expenses', ({ ctx, body }) => ({ status: 201, data: expenses.createExpense(ctx, body) }));
route('POST', '/api/expenses/:id/pay', ({ ctx, params }) => ({ data: expenses.payExpense(ctx, uuid(params)) }));
route('GET', '/api/earnings', ({ ctx }) => ({ data: earnings.listEarnings(ctx) }));
route('GET', '/api/earnings/:id', ({ ctx, params }) => ({ data: earnings.workerStatement(ctx, uuid(params)) }));
route('POST', '/api/earnings/:id/payout', ({ ctx, params, body }) => ({ data: earnings.payWorker(ctx, uuid(params), body) }));

// ---- Inventory ----
route('GET', '/api/inventory', ({ ctx, query }) => ({ data: inventory.listItems(ctx, { filter: query.get('filter') || 'all' }) }));
route('POST', '/api/inventory', ({ ctx, body }) => ({ status: 201, data: inventory.createItem(ctx, body) }));
route('PATCH', '/api/inventory/:id', ({ ctx, params, body }) => ({ data: inventory.updateItem(ctx, uuid(params), body) }));
route('POST', '/api/inventory/:id/movements', ({ ctx, params, body }) => ({ data: inventory.recordMovement(ctx, uuid(params), body) }));

// ---- Reports & audit ----
const reportInput = query => ({ from: query.get('from') || '', to: query.get('to') || '', branchId: query.get('branchId') || '', kind: query.get('kind') || '', format: query.get('format') || '' });
route('GET', '/api/reports/summary', ({ ctx, query }) => ({ data: reports.summary(ctx, reportInput(query)) }));
route('GET', '/api/reports/trial-balance', ({ ctx, query }) => ({ data: reports.trialBalance(ctx, reportInput(query)) }));
route('GET', '/api/reports/workers', ({ ctx }) => ({ data: reports.workerScores(ctx) }));
route('GET', '/api/reports/export', ({ ctx, query }) => ({ file: reports.exportReport(ctx, reportInput(query)) }));
route('GET', '/api/audit', ({ ctx, query }) => ({ data: admin.auditLog(ctx, { limit: query.get('limit'), entityType: query.get('entityType') || '' }) }));

// ---- Customer portal ----
route('GET', '/api/portal', ({ ctx }) => ({ data: publicSite.portalOverview(ctx) }));
route('POST', '/api/portal/vehicles', ({ ctx, body }) => ({ status: 201, data: publicSite.portalAddVehicle(ctx, body) }));
route('POST', '/api/portal/complaints', ({ ctx, body }) => ({ status: 201, data: publicSite.portalComplaint(ctx, body) }));
route('PATCH', '/api/portal/preferences', ({ ctx, body }) => ({ data: publicSite.portalPreferences(ctx, body) }));

export function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = Object.fromEntries(r.keys.map((key, i) => [key, decodeURIComponent(m[i + 1])]));
    return { route: r, params };
  }
  return { route: null, pathMatched };
}
