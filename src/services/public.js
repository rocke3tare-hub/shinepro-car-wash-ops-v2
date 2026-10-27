import { newId } from '../db/database.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { text, email, phone, oneOf, int, bool, id as idField } from '../lib/validate.js';
import { VEHICLE_TYPES } from '../domain/pricing.js';
import { STATUS_LABELS } from '../domain/jobs.js';
import { hashPassword, assertPasswordPolicy, createSession } from './auth.js';
import { normalizePlate, presentVehicle } from './customers.js';

/** The business behind the public site: explicit config, else the only active one. */
export function publicBusinessId(db, config) {
  if (config.publicBusinessId) return config.publicBusinessId;
  const rows = db.all(`SELECT id FROM businesses WHERE status = 'active' ORDER BY created_at LIMIT 2`);
  if (rows.length === 1) return rows[0].id;
  throw new AppError('PUBLIC_BUSINESS_NOT_CONFIGURED', 'The public site is not configured yet.', 503);
}

/**
 * Customer self-signup. Always creates a customer-only account (staff roles can
 * never be requested here) and signs the person in immediately.
 */
export function signup(db, config, input) {
  const businessId = publicBusinessId(db, config);
  const address = email(input.email);
  const displayName = text(input.displayName, 'Name', { required: true, max: 80 });
  const phoneNumber = phone(input.phone, 'Phone', { required: true });
  assertPasswordPolicy(input.password);
  return db.tx(() => {
    if (db.get('SELECT 1 FROM users WHERE email = :email', { email: address })) throw conflict('ACCOUNT_EXISTS', 'An account already exists for this email. Sign in instead.');
    const customerId = newId();
    db.run(`INSERT INTO customers(id, business_id, name, phone, customer_type, marketing_opt_in, language) VALUES (:id, :business, :name, :phone, 'member', :optIn, :language)`,
      { id: customerId, business: businessId, name: displayName, phone: phoneNumber, optIn: bool(input.marketingOptIn) ? 1 : 0, language: input.language === 'fa' ? 'fa' : 'en' });
    const userId = newId();
    db.run(`INSERT INTO users(id, email, password_hash, display_name, phone, status, customer_id) VALUES (:id, :email, :hash, :name, :phone, 'active', :customer)`,
      { id: userId, email: address, hash: hashPassword(input.password, config.passwordPepper), name: displayName, phone: phoneNumber, customer: customerId });
    db.run(`INSERT INTO memberships(id, business_id, user_id, role, branch_id) VALUES (:id, :business, :user, 'customer', NULL)`, { id: newId(), business: businessId, user: userId });
    db.run(`INSERT INTO audit_events(business_id, user_id, role, action, entity_type, entity_id) VALUES (:business, :user, 'customer', 'customer.signed_up', 'customer', :customer)`, { business: businessId, user: userId, customer: customerId });
    return { token: createSession(db, config, userId), userId };
  });
}

export function registerBusiness(db, input) {
  const record = {
    businessName: text(input.businessName, 'Business name', { required: true, max: 120 }),
    contactName: text(input.contactName, 'Contact name', { required: true, max: 80 }),
    phone: phone(input.phone, 'Phone', { required: true }),
    email: email(input.email),
    city: text(input.city, 'City', { required: true, max: 60 }),
    branchCount: int(input.branchCount ?? 1, 'Branch count', { min: 1, max: 500 }),
    description: text(input.description, 'Description', { max: 1000 })
  };
  const id = newId();
  db.run(`INSERT INTO business_registration_requests(id, business_name, contact_name, phone, email, city, branch_count, description) VALUES (:id, :businessName, :contactName, :phone, :email, :city, :branchCount, :description)`, { id, ...record });
  return { id, status: 'submitted' };
}

// ---------- Customer portal: every query is pinned to the caller's own customer id ----------

function requireCustomer(ctx) {
  if (!ctx.actor) throw new AppError('AUTHENTICATION_REQUIRED', 'Sign in is required.', 401);
  if (!ctx.actor.permissions.includes('portal.self') || !ctx.actor.customerId) throw forbidden('This area is for customer accounts.');
  return ctx.actor.customerId;
}

export function portalOverview(ctx) {
  const customerId = requireCustomer(ctx);
  const customer = ctx.db.get('SELECT id, name, phone, customer_type, language, marketing_opt_in FROM customers WHERE id = :id', { id: customerId });
  const vehicles = ctx.db.all('SELECT * FROM vehicles WHERE customer_id = :id ORDER BY created_at', { id: customerId }).map(presentVehicle);
  const jobs = ctx.db.all(`SELECT id, code, plate, service_name, final_price, status, payment_status, created_at, completed_at FROM jobs WHERE customer_id = :id ORDER BY created_at DESC LIMIT 50`, { id: customerId })
    .map(j => ({ ...j, statusLabel: STATUS_LABELS[j.status] }));
  const receipts = ctx.db.all(`SELECT p.id, p.amount, p.tip_amount, p.status, p.created_at, j.code, j.service_name FROM payments p JOIN jobs j ON j.id = p.job_id WHERE j.customer_id = :id ORDER BY p.created_at DESC LIMIT 50`, { id: customerId });
  const loyalty = ctx.db.get('SELECT COALESCE(sum(points), 0) AS points FROM loyalty_transactions WHERE customer_id = :id', { id: customerId }).points;
  const loyaltyHistory = ctx.db.all('SELECT points, reason, created_at FROM loyalty_transactions WHERE customer_id = :id ORDER BY created_at DESC LIMIT 20', { id: customerId });
  const complaints = ctx.db.all('SELECT id, category, description, status, created_at FROM complaints WHERE customer_id = :id ORDER BY created_at DESC LIMIT 20', { id: customerId });
  return { customer, vehicles, jobs, receipts, loyalty: { points: loyalty, history: loyaltyHistory }, complaints };
}

export function portalAddVehicle(ctx, input) {
  const customerId = requireCustomer(ctx);
  const plate = normalizePlate(input.plate);
  if (ctx.db.get('SELECT 1 FROM vehicles WHERE business_id = :business AND plate = :plate', { business: ctx.actor.businessId, plate })) {
    throw conflict('DUPLICATE_PLATE', 'This plate is already registered. Ask the branch to link it to your account.');
  }
  const id = newId();
  ctx.db.run(`INSERT INTO vehicles(id, business_id, customer_id, plate, vehicle_type, brand, model, colour) VALUES (:id, :business, :customer, :plate, :type, :brand, :model, :colour)`, {
    id, business: ctx.actor.businessId, customer: customerId, plate, type: oneOf(input.vehicleType, VEHICLE_TYPES, 'Vehicle type'),
    brand: text(input.brand, 'Brand', { max: 40 }), model: text(input.model, 'Model', { max: 40 }), colour: text(input.colour, 'Colour', { max: 30 })
  });
  return portalOverview(ctx);
}

export function portalComplaint(ctx, input) {
  const customerId = requireCustomer(ctx);
  let jobId = null;
  if (input.jobId) {
    jobId = idField(input.jobId, 'Job');
    if (!ctx.db.get('SELECT 1 FROM jobs WHERE id = :id AND customer_id = :customer', { id: jobId, customer: customerId })) throw notFound('Job');
  }
  ctx.db.run(`INSERT INTO complaints(id, business_id, customer_id, job_id, category, description) VALUES (:id, :business, :customer, :job, :category, :description)`, {
    id: newId(), business: ctx.actor.businessId, customer: customerId, job: jobId,
    category: oneOf(input.category, ['quality', 'damage', 'billing', 'service', 'other'], 'Category'),
    description: text(input.description, 'Description', { required: true, max: 1000 })
  });
  return portalOverview(ctx);
}

export function portalPreferences(ctx, input) {
  const customerId = requireCustomer(ctx);
  ctx.db.run('UPDATE customers SET language = :language, marketing_opt_in = :optIn WHERE id = :id', { id: customerId, language: input.language === 'fa' ? 'fa' : 'en', optIn: bool(input.marketingOptIn) ? 1 : 0 });
  return portalOverview(ctx);
}
