import { api, html, mount, modal, closeModal, toast, toman, money, dateTime, $$, showError } from '../../assets/ui.js';
import { pill } from '../common.js';

export async function render(target, app, [workerId]) {
  const rows = await api('/api/earnings');
  const own = !app.can('earnings.view');
  if (own && rows[0] && !workerId) return render(target, app, [rows[0].workerId]);
  mount(target, html`<div class="page-head"><div><h1>${own ? 'My earnings' : 'Worker earnings'}</h1><p>Commission is earned only after quality approval and customer payment. Refunds reverse it.</p></div></div>
    ${own ? '' : html`<section class="card"><div class="table-wrap"><table><thead><tr><th>Worker</th><th>Score</th><th class="num">Unpaid commission</th><th class="num">Unpaid tips</th><th class="num">Total due</th><th class="num">Paid to date</th><th></th></tr></thead><tbody>
      ${rows.map(w => html`<tr class="clickable" data-worker="${w.workerId}"><td><b>${w.name}</b><br><small>${w.title} · ${w.onShift ? 'on shift' : 'off shift'}</small></td><td>${w.score.score ?? '—'} <small>${w.score.classification}</small></td>
        <td class="num">${toman(w.unpaidCommission)}</td><td class="num">${toman(w.unpaidTips)}</td><td class="num"><b>${toman(w.unpaidTotal)}</b></td><td class="num">${toman(w.paidTotal)}</td>
        <td>${app.can('payouts.create') && w.unpaidTotal > 0 ? html`<button type="button" data-payout="${w.workerId}">Pay out</button>` : ''}</td></tr>`)}</tbody></table></div></section>`}
    <div id="statement"></div>`);
  $$('[data-worker]', target).forEach(r => r.addEventListener('click', event => { if (!event.target.closest('button')) app.go(`earnings/${r.dataset.worker}`); }));
  $$('[data-payout]', target).forEach(b => b.addEventListener('click', () => payout(target, app, rows.find(r => r.workerId === b.dataset.payout))));
  if (workerId) await statement(app, workerId);
}

async function statement(app, workerId) {
  const s = await api(`/api/earnings/${workerId}`);
  mount('#statement', html`<section class="card"><div class="card-head"><h3>${s.worker.name} · statement</h3><b>Due ${toman(s.unpaidTotal)}</b></div>
    ${s.lines.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Job</th><th>Note</th><th>State</th><th class="num">Amount</th></tr></thead><tbody>
      ${s.lines.map(l => html`<tr><td>${dateTime(l.earned_at)}</td><td>${l.kind}</td><td>${l.code || ''}</td><td>${l.note || ''}</td><td>${pill(l.payout_id ? 'paid' : 'unpaid', l.payout_id ? 'paid' : 'unpaid')}</td><td class="num">${toman(l.amount)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No earnings yet.</p>`}
    ${s.payouts.length ? html`<h3>Payouts</h3>${s.payouts.map(p => html`<div class="line"><span>${dateTime(p.created_at)} · ${p.method.replace('_', ' ')}</span><b>${toman(p.amount)}</b></div>`)}` : ''}</section>`);
}

function payout(target, app, worker) {
  const d = modal({ title: `Pay ${worker.name}`, subtitle: `Pays everything currently due: ${money(worker.unpaidTotal)} toman.`,
    body: html`<label for="pm">Method</label><select id="pm"><option value="cash">Cash from the drawer</option><option value="bank_transfer">Bank transfer</option></select>`,
    footer: html`<button type="button" data-close>Cancel</button><button type="button" class="primary" id="go">Confirm payout</button>` });
  d.querySelector('#go').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await api(`/api/earnings/${worker.workerId}/payout`, { method: 'POST', body: { method: d.querySelector('#pm').value } }); closeModal(); toast('Payout recorded.'); render(target, app, [worker.workerId]); }
    catch (error) { showError(error); button.disabled = false; }
  });
}
