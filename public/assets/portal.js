import { api, html, mount, modal, closeModal, onSubmit, toman, dateTime, toast, $, setLanguage } from './ui.js';

const VEHICLES = { small: 'Small', sedan: 'Sedan', suv: 'SUV', van: 'Van' };
const pill = status => html`<span class="pill ${status === 'completed' ? 'green' : status === 'cancelled' || status === 'refunded' ? 'red' : 'amber'}">${status.replaceAll('_', ' ')}</span>`;

async function load() {
  const data = await api('/api/portal');
  setLanguage(data.customer.language);
  const first = data.customer.name.split(' ')[0];
  mount('#portal', html`
    <div class="page-head"><div><p class="eyebrow">Member portal</p><h1>Hello, ${first}</h1><p>Your vehicles, visits and receipts.</p></div>
      <div class="btn-row"><button id="add-vehicle" class="primary" type="button">Add vehicle</button><button id="complain" type="button">Report a problem</button><button id="prefs" type="button">Preferences</button></div></div>
    <div class="metrics">
      <div class="metric"><span>Loyalty points</span><strong>${data.loyalty.points}</strong></div>
      <div class="metric"><span>Visits</span><strong>${data.jobs.length}</strong></div>
      <div class="metric"><span>Vehicles</span><strong>${data.vehicles.length}</strong></div>
    </div>
    <div class="grid two">
      <section class="card"><h3>Vehicles</h3>${data.vehicles.length ? html`<div class="list">${data.vehicles.map(v => html`<div class="list-item"><div><b class="plate">${v.plate}</b><br><small>${[v.brand, v.model, v.colour].filter(Boolean).join(' · ') || VEHICLES[v.vehicleType]}</small></div><span class="pill grey">${VEHICLES[v.vehicleType]}</span></div>`)}</div>` : html`<p class="empty">Add a vehicle so the branch can recognise you on arrival.</p>`}</section>
      <section class="card"><h3>Visits</h3>${data.jobs.length ? html`<div class="list">${data.jobs.map(j => html`<div class="list-item"><div><b>${j.service_name}</b><br><small>${j.code} · ${dateTime(j.created_at)}</small></div><div>${pill(j.status)}<br><small>${toman(j.final_price)}</small></div></div>`)}</div>` : html`<p class="empty">Your visits will appear here.</p>`}</section>
    </div>
    <section class="card"><h3>Receipts</h3>${data.receipts.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Job</th><th>Service</th><th class="num">Paid</th><th>Status</th></tr></thead><tbody>
      ${data.receipts.map(r => html`<tr><td>${dateTime(r.created_at)}</td><td>${r.code}</td><td>${r.service_name}</td><td class="num">${toman(r.amount)}</td><td>${pill(r.status === 'confirmed' ? 'completed' : r.status)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No receipts yet.</p>`}</section>
    ${data.complaints.length ? html`<section class="card"><h3>Your reports</h3><div class="list">${data.complaints.map(c => html`<div class="list-item"><div><b>${c.category}</b><br><small>${c.description}</small></div><span class="pill grey">${c.status.replaceAll('_', ' ')}</span></div>`)}</div></section>` : ''}
  `);
  $('#add-vehicle').addEventListener('click', addVehicle);
  $('#complain').addEventListener('click', () => complain(data.jobs));
  $('#prefs').addEventListener('click', () => preferences(data.customer));
}

function addVehicle() {
  const dialog = modal({ title: 'Add a vehicle', body: html`<form id="f" class="form-grid">
    <div><label for="v-plate">Plate</label><input id="v-plate" name="plate" required></div>
    <div><label for="v-type">Type</label><select id="v-type" name="vehicleType">${Object.entries(VEHICLES).map(([k, v]) => html`<option value="${k}" ${k === 'sedan' ? 'selected' : ''}>${v}</option>`)}</select></div>
    <div><label for="v-brand">Brand</label><input id="v-brand" name="brand"></div><div><label for="v-model">Model</label><input id="v-model" name="model"></div>
    <div class="full"><label for="v-colour">Colour</label><input id="v-colour" name="colour"></div>
    <div class="full"><button class="primary" type="submit">Save vehicle</button></div></form>` });
  onSubmit(dialog.querySelector('#f'), async data => { await api('/api/portal/vehicles', { method: 'POST', body: data }); closeModal(); toast('Vehicle saved.'); load(); });
}

function complain(jobs) {
  const dialog = modal({ title: 'Report a problem', subtitle: 'The branch team reviews every report.', body: html`<form id="f" class="form-grid">
    <div><label for="c-cat">Category</label><select id="c-cat" name="category"><option value="quality">Quality</option><option value="damage">Damage</option><option value="billing">Billing</option><option value="service">Service</option><option value="other">Other</option></select></div>
    <div><label for="c-job">Visit (optional)</label><select id="c-job" name="jobId"><option value="">—</option>${jobs.map(j => html`<option value="${j.id}">${j.code} · ${j.service_name}</option>`)}</select></div>
    <div class="full"><label for="c-desc">What happened?</label><textarea id="c-desc" name="description" required maxlength="1000"></textarea></div>
    <div class="full"><button class="primary" type="submit">Send report</button></div></form>` });
  onSubmit(dialog.querySelector('#f'), async data => { await api('/api/portal/complaints', { method: 'POST', body: data }); closeModal(); toast('Report sent.'); load(); });
}

function preferences(customer) {
  const dialog = modal({ title: 'Preferences', body: html`<form id="f" class="form-grid">
    <div class="full"><label for="p-lang">Language</label><select id="p-lang" name="language"><option value="en" ${customer.language === 'en' ? 'selected' : ''}>English</option><option value="fa" ${customer.language === 'fa' ? 'selected' : ''}>فارسی</option></select></div>
    <label class="check full"><input type="checkbox" name="marketingOptIn" ${customer.marketing_opt_in ? 'checked' : ''}> Send me member offers</label>
    <div class="full"><button class="primary" type="submit">Save</button></div></form>` });
  onSubmit(dialog.querySelector('#f'), async data => { await api('/api/portal/preferences', { method: 'PATCH', body: data }); closeModal(); load(); });
}

$('#logout').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', redirectOn401: false }); } finally { location.href = '/'; } });
load().catch(error => {
  if (error.status === 403) mount('#portal', html`<p class="notice info">This page is for customer accounts. <a href="/app">Open the staff workspace</a>.</p>`);
  else mount('#portal', html`<p class="notice">${error.message}</p>`);
});
