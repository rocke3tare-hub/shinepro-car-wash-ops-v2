import { api, html, mount, toman, money, dateTime, today, $, $$ } from '../../assets/ui.js';
import { options } from '../common.js';

let range = { from: today(), to: today(), branchId: '' };
let tab = 'summary';

const EXPORTS = [['summary', 'Summary & score'], ['jobs', 'Jobs'], ['payments', 'Payments'], ['earnings', 'Earnings'], ['expenses', 'Expenses'], ['ledger', 'Ledger']];

export async function render(target, app) {
  const tabs = [app.can('reports.view') && ['summary', 'Summary'], app.can('reports.view') && ['ledger', 'Trial balance'], app.can('reports.view') && ['export', 'Export'], app.can('audit.view') && ['audit', 'Audit log']].filter(Boolean);
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  mount(target, html`<div class="page-head"><div><h1>Reports</h1><p>Every figure is derived from recorded transactions; scores show which inputs are missing.</p></div></div>
    <div class="toolbar"><div class="tabs">${tabs.map(([k, l]) => html`<button type="button" data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)}</div>
      ${tab !== 'audit' ? html`<form class="filters" id="range"><div><label for="from">From</label><input id="from" type="date" name="from" value="${range.from}"></div><div><label for="to">To</label><input id="to" type="date" name="to" value="${range.to}"></div>
        ${app.branches.length > 1 ? html`<div><label for="br">Branch</label><select id="br" name="branchId">${options(app.branches.map(b => ({ value: b.id, label: b.name })), range.branchId, { blank: 'All branches' })}</select></div>` : ''}<button type="submit">Apply</button></form>` : ''}</div>
    <div id="report"></div>`);
  $$('[data-tab]', target).forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; render(target, app); }));
  $('#range', target)?.addEventListener('submit', e => { e.preventDefault(); const f = e.currentTarget; range = { from: f.from.value, to: f.to.value, branchId: f.branchId?.value || '' }; render(target, app); });
  const q = new URLSearchParams(range);
  if (tab === 'summary') return summary(q);
  if (tab === 'ledger') return ledger(q);
  if (tab === 'export') return exports(q);
  return audit();
}

async function summary(q) {
  const s = await api(`/api/reports/summary?${q}`);
  const m = s.metrics;
  mount('#report', html`<div class="metrics">
      <div class="metric"><span>Net revenue</span><strong>${money(m.netRevenue)}</strong><small>${money(m.revenue)} paid − ${money(m.refunds)} refunded</small></div>
      <div class="metric"><span>Commissions</span><strong>${money(m.commissions)}</strong></div>
      <div class="metric"><span>Expenses paid</span><strong>${money(m.expenses)}</strong></div>
      <div class="metric"><span>Estimated profit</span><strong>${money(m.estimatedProfit)}</strong></div>
      <div class="metric"><span>Jobs</span><strong>${m.jobsCreated}</strong><small>${m.jobsPaid} paid · ${m.jobsCancelled} cancelled</small></div>
      <div class="metric"><span>Tips (to workers)</span><strong>${money(m.tips)}</strong></div>
      <div class="metric"><span>Discounts given</span><strong>${money(m.discounts)}</strong></div>
      <div class="metric ${m.cashDifference ? 'warn' : ''}"><span>Cash difference</span><strong>${money(m.cashDifference)}</strong></div></div>
    <div class="grid two"><section class="card"><div class="card-head"><h3>Branch score</h3><span class="score-ring">${s.score.score ?? '—'}</span></div>
      <p class="muted">${s.score.classification} · ${s.score.completeness}% of the score has data</p>
      ${s.score.factors.map(f => html`<div class="factor"><b>${f.name} <small>(weight ${f.weight})</small></b><span>${f.score == null ? 'No data' : Math.round(f.score)}</span>
        <div class="bar"><i class="${f.score == null ? 'na' : ''}" data-width="${f.score == null ? 0 : Math.round(f.score)}"></i></div><small>${f.explanation}</small></div>`)}</section>
      <section class="card"><h3>Revenue by service</h3>${s.byService.length ? html`<div class="table-wrap"><table><thead><tr><th>Service</th><th class="num">Jobs</th><th class="num">Revenue</th></tr></thead><tbody>
        ${s.byService.map(r => html`<tr><td>${r.service}</td><td class="num">${r.jobs}</td><td class="num">${toman(r.revenue)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No paid jobs in this period.</p>`}
        <h3>Jobs by status</h3>${s.byStatus.map(r => html`<div class="line"><span>${r.label}</span><b>${r.count}</b></div>`)}</section></div>`);
  // Bar widths are set through the CSSOM (allowed by the strict CSP, unlike inline style attributes).
  $$('#report [data-width]').forEach(bar => { bar.style.width = `${bar.dataset.width}%`; });
}

async function ledger(q) {
  const tb = await api(`/api/reports/trial-balance?${q}`);
  mount('#report', html`<section class="card"><div class="card-head"><h3>Trial balance (all time)</h3><span class="pill ${tb.balanced ? 'green' : 'red'}">${tb.balanced ? 'Balanced' : 'Out of balance'}</span></div>
    <div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th class="num">Debits</th><th class="num">Credits</th><th class="num">Balance</th></tr></thead><tbody>
    ${tb.accounts.map(a => html`<tr><td>${a.label}</td><td>${a.type.replace('_', ' ')}</td><td class="num">${money(a.debits)}</td><td class="num">${money(a.credits)}</td><td class="num"><b>${money(a.balance)}</b></td></tr>`)}
    <tr><td><b>Total</b></td><td></td><td class="num"><b>${money(tb.totals.debits)}</b></td><td class="num"><b>${money(tb.totals.credits)}</b></td><td></td></tr></tbody></table></div></section>`);
}

function exports(q) {
  const link = (kind, format) => `/api/reports/export?${new URLSearchParams({ ...Object.fromEntries(q), kind, format })}`;
  mount('#report', html`<section class="card"><h3>Download</h3><p class="muted">Excel files open in Excel, LibreOffice and Google Sheets. CSV files are UTF-8 so Persian text displays correctly.</p>
    <div class="list"><div class="list-item"><div><b>Complete workbook</b><br><small>Every report below, one sheet each</small></div><a class="btn primary" href="${link('all', 'xlsx')}">Excel</a></div>
    ${EXPORTS.map(([k, l]) => html`<div class="list-item"><b>${l}</b><div class="btn-row"><a class="btn" href="${link(k, 'xlsx')}">Excel</a><a class="btn" href="${link(k, 'csv')}">CSV</a></div></div>`)}</div></section>`);
}

async function audit() {
  const rows = await api('/api/audit?limit=300');
  mount('#report', html`<section class="card"><h3>Audit log</h3><p class="muted">Append-only. Entries cannot be edited or deleted.</p>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Reason</th></tr></thead><tbody>
    ${rows.map(r => html`<tr><td>${dateTime(r.created_at)}</td><td>${r.actor || 'system'}</td><td>${r.action}</td><td>${r.entity_type}</td><td>${r.reason || ''}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No events.</p>`}</section>`);
}
