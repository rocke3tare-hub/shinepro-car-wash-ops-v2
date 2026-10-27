import { api, html, mount, modal, closeModal, onSubmit, toast, toman, money, dateTime, $, $$ } from '../../assets/ui.js';
import { pill, options } from '../common.js';

const CATEGORIES = [['direct_job', 'Direct job expense'], ['daily_branch', 'Daily branch expense'], ['monthly_operating', 'Monthly operating expense'], ['inventory_purchase', 'Inventory purchase'], ['maintenance', 'Maintenance'], ['other', 'Other']].map(([value, label]) => ({ value, label }));
const SOURCES = [{ value: 'cash', label: 'Cash (from drawer)' }, { value: 'card', label: 'Card' }, { value: 'bank_transfer', label: 'Bank transfer' }];

export async function render(target, app) {
  const branchId = app.branchId;
  const [cash, expenses] = await Promise.all([
    app.can('cash.operate') ? api(`/api/cash?branchId=${branchId}`) : null,
    api('/api/expenses')
  ]);
  const c = cash?.current;
  mount(target, html`
    <div class="page-head"><div><h1>Cash & expenses</h1><p>${cash ? cash.branch.name : ''} · expected cash is calculated from recorded movements.</p></div>
      <div class="btn-row">
        ${cash && !c ? html`<button class="primary" type="button" id="open">Open register</button>` : ''}
        ${c ? html`<button type="button" id="add">Add cash</button><button type="button" id="remove">Remove / deposit</button><button class="primary" type="button" id="close">Close & count</button>` : ''}
        ${app.can('expenses.create') ? html`<button type="button" id="expense">New expense</button>` : ''}
      </div></div>
    ${cash ? (c ? html`<div class="metrics">
        <div class="metric"><span>Opening float</span><strong>${money(c.openingCash)}</strong></div>
        <div class="metric"><span>Cash payments + tips</span><strong>${money(c.totals.payment + c.totals.tip)}</strong></div>
        <div class="metric"><span>Paid out</span><strong>${money(c.totals.expense + c.totals.refund + c.totals.payout)}</strong><small>expenses · refunds · payouts</small></div>
        <div class="metric"><span>Expected in drawer</span><strong>${money(c.expectedCash)}</strong><small>opened ${dateTime(c.openedAt)}</small></div></div>
      <section class="card"><h3>Movements</h3>${c.movements.length ? html`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Note</th><th>By</th><th class="num">Amount</th></tr></thead><tbody>
        ${c.movements.map(mv => html`<tr><td>${dateTime(mv.createdAt)}</td><td>${mv.label}</td><td>${mv.note || ''}</td><td>${mv.createdBy}</td><td class="num">${toman(mv.amount)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No movements yet.</p>`}</section>`
      : html`<p class="notice info">The register is closed. Open it with the counted float before taking cash.</p>`) : ''}
    ${cash?.recent.length ? html`<section class="card"><h3>Recent closings</h3><div class="table-wrap"><table><thead><tr><th>Closed</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Difference</th><th>Status</th></tr></thead><tbody>
      ${cash.recent.map(r => html`<tr><td>${dateTime(r.closedAt)}<br><small>${r.explanation || ''}</small></td><td class="num">${money(r.expectedCash)}</td><td class="num">${money(r.countedCash)}</td><td class="num">${money(r.difference)}</td><td>${pill(r.status)}</td></tr>`)}</tbody></table></div></section>` : ''}
    <section class="card"><h3>Expenses</h3>${expenses.length ? html`<div class="table-wrap"><table><thead><tr><th>Description</th><th>Category</th><th>Source</th><th>By</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${expenses.map(e => html`<tr><td>${e.description}<br><small>${dateTime(e.createdAt)}</small></td><td>${e.categoryLabel}</td><td>${e.paymentSource.replace('_', ' ')}</td><td>${e.createdBy}</td><td>${pill(e.status)}</td><td class="num">${toman(e.amount)}</td>
        <td>${e.status === 'approved' && app.can('expenses.pay') ? html`<button type="button" data-pay="${e.id}">Pay</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No expenses recorded.</p>`}</section>`);

  const done = message => { closeModal(); toast(message); render(target, app); };
  $('#open', target)?.addEventListener('click', () => {
    const d = modal({ title: 'Open register', body: html`<form id="f"><label for="o">Counted opening float (toman)</label><input id="o" name="openingCash" inputmode="numeric" required></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Open</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/cash/open', { method: 'POST', body: { branchId, ...data } }); done('Register opened.'); });
  });
  for (const kind of ['add', 'remove']) $(`#${kind}`, target)?.addEventListener('click', () => {
    const d = modal({ title: kind === 'add' ? 'Add cash' : 'Remove cash / bank deposit', body: html`<form id="f" class="form-grid"><div><label for="a">Amount</label><input id="a" name="amount" inputmode="numeric" required></div><div><label for="n">Reason</label><input id="n" name="note" required maxlength="200"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Record</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/cash/movements', { method: 'POST', body: { branchId, kind: kind === 'add' ? 'added' : 'removed', ...data } }); done('Cash movement recorded.'); });
  });
  $('#close', target)?.addEventListener('click', () => {
    const d = modal({ title: 'Close register', subtitle: `Expected ${money(c.expectedCash)} toman. Differences above ${money(cash.reviewThreshold)} go to review.`,
      body: html`<form id="f" class="form-grid"><div class="full"><label for="cc">Counted cash</label><input id="cc" name="countedCash" inputmode="numeric" required></div><div class="full"><label for="ex">Explanation (required if it doesn't balance)</label><textarea id="ex" name="explanation" maxlength="500"></textarea></div><p class="full hint" id="diff"></p></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Close register</button>` });
    const input = d.querySelector('#cc');
    input.addEventListener('input', () => { const diff = (Number(input.value) || 0) - c.expectedCash; d.querySelector('#diff').textContent = diff === 0 ? 'Balanced.' : `Difference: ${money(diff)} toman (${diff > 0 ? 'over' : 'short'}).`; });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/cash/close', { method: 'POST', body: { branchId, ...data } }); done('Register closed.'); app.refreshBadges(); });
  });
  $('#expense', target)?.addEventListener('click', () => {
    const d = modal({ title: 'New expense', subtitle: 'Expenses are approved by someone else before they are paid.', body: html`<form id="f" class="form-grid">
      <div class="full"><label for="ed">Description</label><input id="ed" name="description" required maxlength="160"></div>
      <div><label for="ec">Category</label><select id="ec" name="category">${options(CATEGORIES, 'daily_branch')}</select></div>
      <div><label for="ea">Amount (toman)</label><input id="ea" name="amount" inputmode="numeric" required></div>
      <div class="full"><label for="es">Paid by</label><select id="es" name="paymentSource">${options(SOURCES, 'cash')}</select></div>
      <div class="full"><label for="en">Supporting note</label><textarea id="en" name="note" maxlength="500"></textarea></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Submit expense</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/expenses', { method: 'POST', body: { branchId, ...data } }); done('Expense submitted for approval.'); app.refreshBadges(); });
  });
  $$('[data-pay]', target).forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/api/expenses/${b.dataset.pay}/pay`, { method: 'POST', body: {} }); done('Expense paid.'); } catch (error) { b.disabled = false; toast(error.message, 'error'); }
  }));
}
