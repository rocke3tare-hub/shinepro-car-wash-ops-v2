import { api, html, mount, modal, closeModal, onSubmit, toast, toman, dateTime, $, $$ } from '../../assets/ui.js';
import { pill, options } from '../common.js';

const TYPES = [['walk_in', 'Walk-in'], ['member', 'Member'], ['loyalty', 'Loyalty'], ['fleet', 'Fleet'], ['business', 'Business']].map(([value, label]) => ({ value, label }));
const VEHICLES = [{ value: 'small', label: 'Small' }, { value: 'sedan', label: 'Sedan' }, { value: 'suv', label: 'SUV' }, { value: 'van', label: 'Van' }];
const typeLabel = t => TYPES.find(x => x.value === t)?.label || t;
let query = { q: '', type: '' };

export async function render(target, app, [customerId]) {
  const rows = await api(`/api/customers?${new URLSearchParams(query)}`);
  mount(target, html`<div class="page-head"><div><h1>Customers</h1><p>Profiles, vehicles, visits and credit.</p></div>
      <div class="btn-row">${app.can('customers.manage') ? html`<button class="primary" type="button" id="new">New customer</button>` : ''}</div></div>
    <div class="toolbar"><div class="filters"><div><label for="q">Search</label><input id="q" type="search" value="${query.q}" placeholder="Name or phone"></div>
      <div><label for="t">Type</label><select id="t">${options(TYPES, query.type, { blank: 'All types' })}</select></div></div></div>
    <div class="jobs-layout"><section class="card">${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th class="num">Visits</th><th class="num">Spend</th></tr></thead><tbody>
      ${rows.map(c => html`<tr class="clickable" data-id="${c.id}"><td><b>${c.name}</b><br><small>${c.phone || ''}</small></td><td>${pill('approved', typeLabel(c.customerType))}</td><td class="num">${c.visits}</td><td class="num">${toman(c.spend)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No customers found.</p>`}</section>
      <section class="card job-detail" id="detail"><p class="empty">Select a customer.</p></section></div>`);
  let timer;
  $('#q', target).addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { query.q = e.target.value; render(target, app, [customerId]); }, 300); });
  $('#t', target).addEventListener('change', e => { query.type = e.target.value; render(target, app, [customerId]); });
  $('#new', target)?.addEventListener('click', () => editCustomer(app, null));
  $$('[data-id]', target).forEach(r => r.addEventListener('click', () => app.go(`customers/${r.dataset.id}`)));
  if (customerId) await detail(app, customerId);
}

async function detail(app, id) {
  const c = await api(`/api/customers/${id}`);
  mount('#detail', html`<div class="card-head"><div><h3>${c.name}</h3><small>${c.phone || 'No phone'} · ${typeLabel(c.customerType)}</small></div>
      <div class="btn-row">${app.can('customers.manage') ? html`<button type="button" id="edit">Edit</button><button type="button" id="veh">Add vehicle</button>` : ''}${app.can('approvals.cash') ? html`<button type="button" id="credit">Credit limit</button>` : ''}</div></div>
    ${c.note ? html`<p class="hint">${c.note}</p>` : ''}
    <div class="line"><span>Visits</span><b>${c.visits}</b></div><div class="line"><span>Total spend</span><b>${toman(c.spend)}</b></div>
    <div class="line"><span>Loyalty points</span><b>${c.loyaltyPoints}</b></div>
    <div class="line"><span>Credit used / limit</span><b>${toman(c.creditUsed)} / ${toman(c.creditLimit)}</b></div>
    <h3>Vehicles</h3>${c.vehicles.length ? html`<div class="list">${c.vehicles.map(v => html`<div class="list-item"><div><b class="plate">${v.plate}</b><br><small>${[v.brand, v.model, v.colour].filter(Boolean).join(' · ')}</small></div><span class="pill grey">${VEHICLES.find(x => x.value === v.vehicleType)?.label}</span></div>`)}</div>` : html`<p class="muted">No vehicles.</p>`}
    <h3>Recent visits</h3>${c.jobs.length ? html`<div class="list">${c.jobs.map(j => html`<div class="list-item clickable" data-job="${j.id}"><div><b>${j.code}</b> · ${j.service_name}<br><small>${dateTime(j.created_at)}</small></div><div>${pill(j.status)}<br><small>${toman(j.final_price)}</small></div></div>`)}</div>` : html`<p class="muted">No visits yet.</p>`}`);
  $('#edit')?.addEventListener('click', () => editCustomer(app, c));
  $('#veh')?.addEventListener('click', () => addVehicle(app, c));
  $('#credit')?.addEventListener('click', () => creditLimit(app, c));
  $$('#detail [data-job]').forEach(r => r.addEventListener('click', () => app.go(`jobs/${r.dataset.job}`)));
}

function editCustomer(app, c) {
  const d = modal({ title: c ? 'Edit customer' : 'New customer', body: html`<form id="f" class="form-grid">
    <div class="full"><label for="n">Name</label><input id="n" name="name" required maxlength="120" value="${c?.name || ''}"></div>
    <div><label for="p">Phone</label><input id="p" name="phone" inputmode="tel" value="${c?.phone || ''}"></div>
    <div><label for="t">Type</label><select id="t" name="customerType">${options(TYPES, c?.customerType || 'walk_in')}</select></div>
    <div class="full"><label for="no">Note</label><textarea id="no" name="note" maxlength="500">${c?.note || ''}</textarea></div></form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
  onSubmit(d.querySelector('#f'), async data => {
    const saved = c ? await api(`/api/customers/${c.id}`, { method: 'PATCH', body: { ...data, expectedVersion: c.version } }) : await api('/api/customers', { method: 'POST', body: data });
    closeModal(); toast('Customer saved.'); app.go(`customers/${saved.id}`); if (c) detail(app, saved.id);
  });
}

function addVehicle(app, c) {
  const d = modal({ title: 'Add vehicle', subtitle: c.name, body: html`<form id="f" class="form-grid">
    <div><label for="pl">Plate</label><input id="pl" name="plate" required maxlength="32"></div><div><label for="vt">Type</label><select id="vt" name="vehicleType">${options(VEHICLES, 'sedan')}</select></div>
    <div><label for="b">Brand</label><input id="b" name="brand"></div><div><label for="m">Model</label><input id="m" name="model"></div><div class="full"><label for="co">Colour</label><input id="co" name="colour"></div></form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save vehicle</button>` });
  onSubmit(d.querySelector('#f'), async data => { await api('/api/vehicles', { method: 'POST', body: { ...data, customerId: c.id } }); closeModal(); toast('Vehicle added.'); detail(app, c.id); });
}

function creditLimit(app, c) {
  const d = modal({ title: 'Credit limit', subtitle: `${c.name} · currently ${c.creditLimit.toLocaleString('en-US')} toman`, body: html`<form id="f" class="form-grid">
    <div><label for="l">New limit (toman)</label><input id="l" name="creditLimit" inputmode="numeric" required value="${c.creditLimit}"></div><div><label for="r">Reason</label><input id="r" name="reason" required maxlength="300"></div></form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
  onSubmit(d.querySelector('#f'), async data => { await api(`/api/customers/${c.id}/credit-limit`, { method: 'POST', body: data }); closeModal(); toast('Credit limit updated.'); detail(app, c.id); });
}
