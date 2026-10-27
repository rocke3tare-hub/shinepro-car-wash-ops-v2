import { api, html, mount, modal, closeModal, onSubmit, toast, toman, dateTime, $$ } from '../../assets/ui.js';
import { pill } from '../common.js';

const KIND = { discount: 'Discount', refund: 'Refund', expense: 'Expense', cash_difference: 'Cash difference' };
let status = 'pending';

export async function render(target, app) {
  const rows = await api(`/api/approvals?status=${status}`);
  mount(target, html`<div class="page-head"><div><h1>Approvals</h1><p>Restricted actions need a second authorised person. You cannot decide your own requests.</p></div></div>
    <div class="tabs">${[['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']].map(([v, l]) => html`<button type="button" data-status="${v}" class="${status === v ? 'active' : ''}">${l}</button>`)}</div>
    <section class="card">${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Type</th><th>Details</th><th class="num">Amount</th><th>Requested</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(a => html`<tr><td><b>${KIND[a.kind]}</b></td><td>${a.payload.code || a.payload.category || a.payload.branch || ''}<br><small>${a.reason}</small>${a.decisionNote ? html`<br><small>Decision: ${a.decisionNote}</small>` : ''}</td>
        <td class="num">${toman(a.amount)}</td><td>${a.requestedBy}<br><small>${dateTime(a.createdAt)}</small></td><td>${pill(a.status)}${a.decidedBy ? html`<br><small>${a.decidedBy}</small>` : ''}</td>
        <td>${a.status === 'pending' ? (a.selfRequested ? html`<small>Your request</small>` : html`<button type="button" data-decide="${a.id}">Review</button>`) : ''}${a.subjectType === 'job' ? html` <button type="button" class="ghost" data-job="${a.subjectId}">Open job</button>` : ''}</td></tr>`)}
      </tbody></table></div>` : html`<p class="empty">Nothing here.</p>`}</section>`);
  $$('[data-status]', target).forEach(b => b.addEventListener('click', () => { status = b.dataset.status; render(target, app); }));
  $$('[data-job]', target).forEach(b => b.addEventListener('click', () => app.go(`jobs/${b.dataset.job}`)));
  $$('[data-decide]', target).forEach(b => b.addEventListener('click', () => decide(target, app, rows.find(r => r.id === b.dataset.decide))));
}

function decide(target, app, approval) {
  const dialog = modal({ title: `${KIND[approval.kind]} request`, subtitle: `${approval.requestedBy} · ${dateTime(approval.createdAt)}`,
    body: html`<div class="line"><span>Amount</span><b>${toman(approval.amount)}</b></div><div class="line"><span>Reason</span><b>${approval.reason}</b></div>
      <form id="f"><label for="n">Decision note (required to reject)</label><textarea id="n" name="note" maxlength="300"></textarea><input type="hidden" name="decision"></form>`,
    footer: html`<button type="button" class="danger" data-d="reject">Reject</button><button type="button" class="primary" data-d="approve">Approve</button>` });
  const form = dialog.querySelector('#f');
  dialog.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => { form.elements.decision.value = b.dataset.d; form.requestSubmit(); }));
  onSubmit(form, async data => { await api(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: data }); closeModal(); toast(`Request ${data.decision === 'approve' ? 'approved' : 'rejected'}.`); app.refreshBadges(); render(target, app); });
}
