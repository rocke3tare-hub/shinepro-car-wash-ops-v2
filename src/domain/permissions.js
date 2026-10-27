// Role -> permission policy. This table is the single source of truth: the API
// enforces it and the UI only reads the resulting permission list to decide
// what to show.

export const ROLES = ['owner', 'company_admin', 'branch_manager', 'accountant', 'cashier', 'quality_controller', 'team_leader', 'worker', 'inventory_manager', 'customer'];

export const ROLE_LABELS = {
  owner: 'Owner',
  company_admin: 'Company administrator',
  branch_manager: 'Branch manager',
  accountant: 'Accountant',
  cashier: 'Cashier',
  quality_controller: 'Quality controller',
  team_leader: 'Team leader',
  worker: 'Worker',
  inventory_manager: 'Inventory manager',
  customer: 'Customer'
};

export const PERMISSIONS = [
  'jobs.view', 'jobs.view_own', 'jobs.create', 'jobs.edit', 'jobs.assign', 'jobs.work', 'jobs.quality', 'jobs.cancel',
  'payments.create', 'refunds.request',
  'approvals.discount', 'approvals.refund', 'approvals.expense', 'approvals.cash',
  'customers.view', 'customers.manage',
  'cash.operate', 'expenses.create', 'expenses.pay',
  'earnings.view', 'earnings.view_own', 'payouts.create',
  'inventory.view', 'inventory.manage',
  'reports.view', 'audit.view', 'settings.manage', 'staff.manage', 'workers.manage',
  'portal.self'
];

const STAFF_BASE = ['jobs.view', 'customers.view'];

export const ROLE_PERMISSIONS = Object.freeze({
  owner: PERMISSIONS.filter(p => p !== 'portal.self' && p !== 'jobs.view_own' && p !== 'earnings.view_own'),
  company_admin: [...STAFF_BASE, 'jobs.create', 'jobs.edit', 'jobs.assign', 'jobs.cancel', 'customers.manage', 'inventory.view', 'inventory.manage', 'reports.view', 'audit.view', 'settings.manage', 'staff.manage', 'workers.manage', 'approvals.discount', 'earnings.view'],
  branch_manager: [...STAFF_BASE, 'jobs.create', 'jobs.edit', 'jobs.assign', 'jobs.work', 'jobs.quality', 'jobs.cancel', 'payments.create', 'refunds.request', 'approvals.discount', 'approvals.expense', 'customers.manage', 'cash.operate', 'expenses.create', 'expenses.pay', 'earnings.view', 'inventory.view', 'inventory.manage', 'reports.view', 'audit.view', 'workers.manage'],
  accountant: [...STAFF_BASE, 'payments.create', 'refunds.request', 'approvals.refund', 'approvals.expense', 'approvals.cash', 'cash.operate', 'expenses.create', 'expenses.pay', 'earnings.view', 'payouts.create', 'reports.view', 'audit.view'],
  cashier: [...STAFF_BASE, 'jobs.create', 'jobs.edit', 'jobs.assign', 'payments.create', 'refunds.request', 'customers.manage', 'cash.operate', 'expenses.create'],
  quality_controller: [...STAFF_BASE, 'jobs.quality'],
  team_leader: [...STAFF_BASE, 'jobs.assign', 'jobs.work'],
  worker: ['jobs.view_own', 'jobs.work', 'earnings.view_own'],
  inventory_manager: ['inventory.view', 'inventory.manage'],
  customer: ['portal.self']
});

/** Roles whose membership grants every branch even without branch_id = NULL. */
const BUSINESS_WIDE_ROLES = new Set(['owner', 'company_admin', 'accountant']);

/**
 * Build the authorization context for one user inside one business from their
 * membership rows: [{ role, branch_id }].
 */
export function buildScope(memberships) {
  const roles = [...new Set(memberships.map(m => m.role))];
  const permissions = new Set(roles.flatMap(role => ROLE_PERMISSIONS[role] || []));
  const allBranches = memberships.some(m => m.branch_id === null || BUSINESS_WIDE_ROLES.has(m.role));
  const branchIds = [...new Set(memberships.filter(m => m.branch_id).map(m => m.branch_id))];
  return { roles, permissions: [...permissions].sort(), allBranches, branchIds };
}

export function can(actor, permission) {
  return Boolean(actor && actor.permissions && actor.permissions.includes(permission));
}

export function canAccessBranch(actor, branchId) {
  return Boolean(actor && (actor.allBranches || actor.branchIds.includes(branchId)));
}

/** A worker-only actor sees only jobs they are assigned to. */
export function isOwnJobsOnly(actor) {
  return can(actor, 'jobs.view_own') && !can(actor, 'jobs.view');
}
