import { api, html, raw, mount, $, $$, toast, showError, initLanguage, setLanguage } from '../assets/ui.js';
import * as overview from './views/overview.js';
import * as jobs from './views/jobs.js';
import * as approvals from './views/approvals.js';
import * as cash from './views/cash.js';
import * as earnings from './views/earnings.js';
import * as customers from './views/customers.js';
import * as inventory from './views/inventory.js';
import * as reports from './views/reports.js';
import * as team from './views/team.js';
import * as settings from './views/settings.js';

// Each view declares the permissions that make it visible; the API enforces
// the same permissions again, so hiding a link is convenience, not security.
const VIEWS = [
  { key: 'overview', label: 'Overview', module: overview, any: ['jobs.view', 'jobs.view_own', 'reports.view'] },
  { key: 'jobs', label: 'Jobs', module: jobs, any: ['jobs.view', 'jobs.view_own'] },
  { key: 'approvals', label: 'Approvals', module: approvals, any: ['approvals.discount', 'approvals.refund', 'approvals.expense', 'approvals.cash'] },
  { key: 'cash', label: 'Cash & expenses', module: cash, any: ['cash.operate', 'expenses.create', 'expenses.pay'] },
  { key: 'earnings', label: 'Earnings', module: earnings, any: ['earnings.view', 'earnings.view_own'] },
  { key: 'customers', label: 'Customers', module: customers, any: ['customers.view'] },
  { key: 'inventory', label: 'Inventory', module: inventory, any: ['inventory.view'] },
  { key: 'reports', label: 'Reports', module: reports, any: ['reports.view', 'audit.view'] },
  { key: 'team', label: 'Team', module: team, any: ['workers.manage', 'staff.manage'] },
  { key: 'settings', label: 'Settings', module: settings, any: [] }
];

export const app = {
  me: null,
  can: permission => app.me.permissions.includes(permission),
  canAny: list => list.length === 0 || list.some(p => app.me.permissions.includes(p)),
  branchId: null,
  branches: [],
  go: path => { location.hash = `#/${path}`; },
  refreshBadges: () => refreshBadges()
};

function visibleViews() { return VIEWS.filter(v => app.canAny(v.any)); }

function renderNav(active) {
  mount('#nav', visibleViews().map(v => html`<button type="button" data-view="${v.key}" class="${v.key === active ? 'active' : ''}" ${v.key === active ? raw('aria-current="page"') : ''}>${v.label}<span class="badge hidden" data-badge="${v.key}"></span></button>`));
  $$('#nav [data-view]').forEach(b => b.addEventListener('click', () => { app.go(b.dataset.view); $('#sidebar').classList.remove('open'); }));
  refreshBadges();
}

async function refreshBadges() {
  if (!app.canAny(['approvals.discount', 'approvals.refund', 'approvals.expense', 'approvals.cash'])) return;
  try {
    const pending = (await api('/api/approvals')).filter(a => !a.selfRequested).length;
    const badge = $('[data-badge="approvals"]');
    if (badge) { badge.textContent = pending; badge.classList.toggle('hidden', !pending); }
  } catch { /* badge is optional */ }
}

let current = null;
async function route() {
  const [key = 'overview', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const views = visibleViews();
  const view = views.find(v => v.key === key) || views[0];
  if (!view) { mount('#view', html`<p class="notice">Your account has no workspace access. Ask an administrator to assign a role.</p>`); return; }
  renderNav(view.key);
  current = view.key;
  const target = $('#view');
  mount(target, html`<p class="muted">Loading…</p>`);
  try {
    await view.module.render(target, app, rest.map(decodeURIComponent));
    if (current === view.key) target.focus({ preventScroll: true });
  } catch (error) {
    if (error.status === 401) return;
    mount(target, html`<p class="notice">${error.message}</p>`);
    showError(error);
  }
}

async function boot() {
  initLanguage();
  try {
    app.me = await api('/api/me');
  } catch { return; } // api() already redirected to sign-in
  if (app.me.permissions.length === 1 && app.me.permissions[0] === 'portal.self') { location.href = '/portal'; return; }
  app.branches = app.me.branches;
  try { app.branchId = localStorage.getItem('sp-branch'); } catch { app.branchId = null; }
  if (!app.branches.some(b => b.id === app.branchId)) app.branchId = app.branches[0]?.id || null;
  $('#env-label').textContent = 'STAGING';
  api('/api/health', { redirectOn401: false }).then(h => { $('#env-label').textContent = h.label; }).catch(() => {});
  mount('#me', html`<b>${app.me.user.displayName}</b><span>${app.me.roles.map(r => r.label).join(', ')}</span>
    ${app.branches.length > 1 ? html`<label class="sr-only" for="branch-pick">Branch</label><select id="branch-pick">${app.branches.map(b => html`<option value="${b.id}" ${b.id === app.branchId ? 'selected' : ''}>${b.name}</option>`)}</select>` : html`<small>${app.branches[0]?.name || ''}</small>`}
    <button type="button" id="lang-btn">EN / فا</button><button type="button" id="logout-btn">Sign out</button>`);
  $('#branch-pick')?.addEventListener('change', event => { app.branchId = event.target.value; try { localStorage.setItem('sp-branch', app.branchId); } catch { /* ignore */ } route(); });
  $('#lang-btn').addEventListener('click', () => { const next = document.documentElement.lang === 'fa' ? 'en' : 'fa'; setLanguage(next); toast(next === 'fa' ? 'حالت راست‌به‌چپ' : 'English layout'); });
  $('#logout-btn').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', redirectOn401: false }); } finally { location.href = '/'; } });
  $('#menu-btn').addEventListener('click', event => { const open = $('#sidebar').classList.toggle('open'); event.currentTarget.setAttribute('aria-expanded', String(open)); });
  window.addEventListener('hashchange', route);
  route();
}

boot();
