import { api, html, mount, modal, closeModal, onSubmit, toast, toman, money, dateTime, minutesSince, idempotencyKey, $, $$, showError, formData } from '../../assets/ui.js';
import { pill, options, checked, PAYMENT_METHODS, methodLabel } from '../common.js';

const STATUS_TABS = [['open', 'Open'], ['waiting', 'Waiting'], ['in_progress', 'In progress'], ['ready_for_quality', 'Quality'], ['ready_for_payment', 'Payment'], ['completed', 'Completed'], ['', 'All']];
const VEHICLES = [{ value: 'small', label: 'Small' }, { value: 'sedan', label: 'Sedan' }, { value: 'suv', label: 'SUV' }, { value: 'van', label: 'Van' }];
let filter = { status: 'open', q: '' };
let cache = { services: null, workers: null };

async function services() { cache.services ??= await api('/api/services'); return cache.services; }
async function workers() { cache.workers ??= await api('/api/workers'); return cache.workers; }

export async function render(target, app, [jobId, sub]) {
  cache = { services: null, workers: null };
  if (jobId && sub === 'receipt') return renderReceipt(target, jobId);
  mount(target, html`
    <div class="page-head"><div><h1>Jobs</h1><p>Every vehicle from arrival to payment.</p></div>
      <div class="btn-row">${app.can('jobs.create') ? html`<button class="primary" id="new-job" type="button">New job</button>` : ''}</div></div>
    <div class="toolbar"><div class="tabs" role="tablist">${STATUS_TABS.map(([value, label]) => html`<button type="button" role="tab" data-status="${value}" class="${filter.status === value ? 'active' : ''}" aria-selected="${filter.status === value}">${label}</button>`)}</div>
      <div class="filters"><div><label for="job-q" class="sr-only">Search</label><input id="job-q" type="search" placeholder="Search code, plate, customer…" value="${filter.q}"></div></div></div>
    <div class="jobs-layout"><section class="card" id="job-list"></section><section class="card job-detail" id="job-detail"><p class="empty">Select a job to see its details.</p></section></div>`);
  $$('[data-status]', target).forEach(b => b.addEventListener('click', () => { filter.status = b.dataset.status; render(target, app, [jobId]); }));
  let timer;
  $('#job-q', target).addEventListener('input', event => { clearTimeout(timer); timer = setTimeout(() => { filter.q = event.target.value; loadList(app, jobId); }, 250); });
  $('#new-job', target)?.addEventListener('click', () => newJob(app));
  await loadList(app, jobId);
  if (jobId) await loadDetail(app, jobId);
}

async function loadList(app, activeId) {
  const params = new URLSearchParams({ status: filter.status, q: filter.q });
  const rows = await api(`/api/jobs?${params}`);
  mount('#job-list', rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Job</th><th>Vehicle</th><th>Service</th><th>Status</th><th class="num">Price</th></tr></thead><tbody>
    ${rows.map(j => html`<tr class="clickable ${j.id === activeId ? 'active' : ''}" data-job="${j.id}" tabindex="0"><td><span class="job-code">${j.code}</span><br><small>${dateTime(j.createdAt)}</small></td>
      <td><span class="plate">${j.plate}</span><br><small>${j.customerName}</small></td><td>${j.serviceName}<br><small>${j.workers.join(', ') || 'Unassigned'}</small></td>
      <td>${pill(j.status, j.statusLabel)}${j.discountStatus === 'pending' ? html`<br><span class="pill amber">discount pending</span>` : ''}</td><td class="num">${toman(j.finalPrice)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="empty">No jobs match this view.</p>`);
  $$('[data-job]').forEach(row => {
    const open = () => app.go(`jobs/${row.dataset.job}`);
    row.addEventListener('click', open);
    row.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
  });
}

async function loadDetail(app, jobId) {
  const job = await api(`/api/jobs/${jobId}`);
  const actionButtons = job.actions.map(a => html`<button type="button" data-action="${a.action}" class="${a.action === 'approve_quality' || a.action === 'start' || a.action === 'submit_for_quality' ? 'primary' : a.action === 'cancel' ? 'danger' : ''}" ${a.blocked ? html`disabled title="${a.blocked}"` : ''}>${a.label}</button>`);
  mount('#job-detail', html`
    <div class="card-head"><div><span class="job-code">${job.code}</span> ${pill(job.status, job.statusLabel)}<br><small>Arrived ${dateTime(job.createdAt)} · ${minutesSince(job.createdAt)} min ago</small></div>
      <button type="button" class="icon-btn" id="close-detail" aria-label="Close details">×</button></div>
    <div class="line"><span>Vehicle</span><b><span class="plate">${job.plate}</span> · ${job.vehicleLabel || ''} ${VEHICLES.find(v => v.value === job.vehicleType)?.label}</b></div>
    <div class="line"><span>Customer</span><b>${job.customerName}${job.customerPhone ? html` · ${job.customerPhone}` : ''}</b></div>
    <div class="line"><span>Service</span><b>${job.serviceName}</b></div>
    <div class="line"><span>Bay</span><b>${job.bay || 'Unassigned'}</b></div>
    ${job.originalPrice != null ? html`<div class="line"><span>Price</span><b>${toman(job.originalPrice)}</b></div>
      ${job.discount ? html`<div class="line"><span>Discount (${job.discountReason || '—'})</span><b>−${money(job.discount)} ${pill(job.discountStatus)}</b></div>` : ''}
      <div class="line"><span>Amount due</span><b>${toman(job.finalPrice)}</b></div>` : ''}
    ${job.notes ? html`<p class="hint">Note: ${job.notes}</p>` : ''}${job.existingDamage ? html`<p class="notice">Existing damage: ${job.existingDamage}</p>` : ''}
    ${job.cancelReason ? html`<p class="notice">Cancelled: ${job.cancelReason}</p>` : ''}
    <h3>Team${job.commissionTotal != null ? html` · commission ${toman(job.commissionTotal)}` : ''}</h3>
    ${job.assignments.length ? html`<div class="list">${job.assignments.map(a => html`<div class="list-item"><div><b>${a.workerName}</b><br><small>${a.role} · ${(a.basisPoints / 100).toFixed(2)}%</small></div><div>${pill(a.status)}${a.amount != null ? html`<br><small>${toman(a.amount)}</small>` : ''}</div></div>`)}</div>` : html`<p class="muted">No workers assigned yet.</p>`}
    <div class="btn-row no-print" id="job-actions">
      ${actionButtons}
      ${job.canAssign ? html`<button type="button" id="assign-btn">Assign workers</button>` : ''}
      ${job.canTakePayment ? html`<button type="button" class="primary" id="pay-btn">Take payment</button>` : ''}
      ${job.editable ? html`<button type="button" id="edit-btn">Edit</button>` : ''}
      ${job.editable && job.paymentStatus === 'unpaid' ? html`<button type="button" id="discount-btn">Discount</button>` : ''}
      ${job.canRequestRefund ? html`<button type="button" class="danger" id="refund-btn">Request refund</button>` : ''}
      ${job.payment ? html`<button type="button" id="receipt-btn">Receipt</button>` : ''}
    </div>
    ${job.payment ? html`<h3>Payment</h3>${job.payment.parts.map(p => html`<div class="line"><span>${methodLabel(p.method)}</span><b>${toman(p.amount)}</b></div>`)}
      ${job.payment.tipAmount ? html`<div class="line"><span>Tip (${methodLabel(job.payment.tipMethod)})</span><b>${toman(job.payment.tipAmount)}</b></div>` : ''}
      ${job.refunds.map(r => html`<div class="line"><span>Refund · ${r.reason}</span><b>−${money(r.amount)} ${pill(r.status)}</b></div>`)}` : ''}
    ${job.quality.length ? html`<h3>Quality checks</h3>${job.quality.map(q => html`<div class="line"><span>${q.inspector} · ${dateTime(q.created_at)}${q.notes ? html`<br><small>${q.notes}</small>` : ''}</span><b>${pill(q.outcome === 'passed' ? 'approved' : 'rework_required', q.outcome)}</b></div>`)}` : ''}
    ${job.history.length ? html`<details><summary>History (${job.history.length})</summary><div class="timeline">${job.history.map(h => html`<div><b>${h.action.replace('job.', '').replaceAll('_', ' ')}</b> · ${h.actor || 'system'}<br><small>${dateTime(h.created_at)}${h.reason ? html` · ${h.reason}` : ''}</small></div>`)}</div></details>` : ''}`);

  $('#close-detail').addEventListener('click', () => app.go('jobs'));
  $$('#job-actions [data-action]').forEach(b => b.addEventListener('click', () => runAction(app, job, b.dataset.action)));
  $('#assign-btn')?.addEventListener('click', () => assign(app, job));
  $('#pay-btn')?.addEventListener('click', () => pay(app, job));
  $('#edit-btn')?.addEventListener('click', () => edit(app, job));
  $('#discount-btn')?.addEventListener('click', () => discount(app, job));
  $('#refund-btn')?.addEventListener('click', () => refund(app, job));
  $('#receipt-btn')?.addEventListener('click', () => app.go(`jobs/${job.id}/receipt`));
}

const reload = async (app, jobId) => { await loadList(app, jobId); await loadDetail(app, jobId); app.refreshBadges(); };

async function post(app, job, path, body) {
  await api(path, { method: 'POST', body: { expectedVersion: job.version, ...body } });
  closeModal();
  await reload(app, job.id);
}

function runAction(app, job, action) {
  if (action === 'approve_quality' || action === 'request_rework') return qualityCheck(app, job, action);
  if (action === 'cancel' || action === 'pause') {
    const dialog = modal({ title: action === 'cancel' ? 'Cancel job' : 'Pause work', subtitle: job.code,
      body: html`<form id="f"><label for="r">Reason${action === 'cancel' ? '' : ' (optional)'}</label><textarea id="r" name="reason" ${action === 'cancel' ? 'required' : ''} maxlength="300"></textarea></form>`,
      footer: html`<button type="button" data-close>Back</button><button form="f" class="${action === 'cancel' ? 'danger' : 'primary'}" type="submit">${action === 'cancel' ? 'Cancel job' : 'Pause'}</button>` });
    return onSubmit(dialog.querySelector('#f'), data => post(app, job, `/api/jobs/${job.id}/actions/${action}`, data).then(() => toast(action === 'cancel' ? 'Job cancelled.' : 'Work paused.')));
  }
  post(app, job, `/api/jobs/${job.id}/actions/${action}`, {}).then(() => toast('Job updated.')).catch(showError);
}

function qualityCheck(app, job, initial) {
  const dialog = modal({ title: 'Quality check', subtitle: `${job.code} · ${job.serviceName}`,
    body: html`<form id="f"><div class="checklist">${job.checklist.map((item, i) => html`<label class="check"><input type="checkbox" name="c${i}" data-item="${item}" ${checked(initial === 'approve_quality')}> ${item}</label>`)}</div>
      <label for="qn">Notes / rework reason</label><textarea id="qn" name="reason" maxlength="300"></textarea>
      <p class="hint">Approval needs every item ticked. Rework needs a reason.</p></form>`,
    footer: html`<button type="button" class="danger" id="rework">Request rework</button><button type="button" class="primary" id="approve">Approve quality</button>` });
  const results = () => $$('[data-item]', dialog).map(box => ({ item: box.dataset.item, passed: box.checked }));
  const send = async (action, button) => {
    button.disabled = true;
    try {
      const reason = dialog.querySelector('#qn').value;
      await post(app, job, `/api/jobs/${job.id}/actions/${action}`, { results: results(), reason, notes: reason });
      toast(action === 'approve_quality' ? 'Quality approved. Ready for payment.' : 'Rework requested.');
    } catch (error) { showError(error); } finally { button.disabled = false; }
  };
  dialog.querySelector('#approve').addEventListener('click', event => send('approve_quality', event.currentTarget));
  dialog.querySelector('#rework').addEventListener('click', event => send('request_rework', event.currentTarget));
}

function assignmentRows(service, workerList, current) {
  const roles = service?.commission?.rules || [];
  const rows = current.length ? current : [{}];
  return rows.map(a => html`<div class="assign-row"><select name="worker" aria-label="Worker">${options(workerList.map(w => ({ value: w.id, label: `${w.name}${w.onShift ? '' : ' (off shift)'}` })), a.workerId, { blank: 'Choose worker' })}</select>
    <select name="role" aria-label="Role">${options(roles.map(r => ({ value: r.role, label: `${r.role} · ${(r.basisPoints / 100).toFixed(2)}%` })), a.role, { blank: 'Choose role' })}</select>
    <button type="button" class="icon-btn" data-remove aria-label="Remove row">−</button></div>`);
}

function readAssignments(root) {
  return $$('.assign-row', root).map(row => ({ workerId: row.querySelector('[name=worker]').value, role: row.querySelector('[name=role]').value })).filter(a => a.workerId || a.role);
}

function wireAssignmentEditor(root, getService, workerList) {
  root.addEventListener('click', event => {
    if (event.target.closest('[data-remove]')) { event.target.closest('.assign-row').remove(); }
    if (event.target.closest('[data-add-row]')) {
      $('.assign-rows', root).insertAdjacentHTML('beforeend', String(assignmentRows(getService(), workerList, [{}])));
    }
  });
}

async function assign(app, job) {
  const [serviceList, workerList] = await Promise.all([services(), workers()]);
  const service = serviceList.find(s => s.id === job.serviceId);
  const branchWorkers = workerList.filter(w => w.branchId === job.branchId);
  const dialog = modal({ title: 'Assign workers', subtitle: `${job.code} · rates come from the ${job.serviceName} commission rules`, wide: true,
    body: html`<div class="assign-rows">${assignmentRows(service, branchWorkers, job.assignments)}</div><button type="button" data-add-row>Add worker</button>`,
    footer: html`<button type="button" data-close>Cancel</button><button type="button" class="primary" id="save">Save assignments</button>` });
  wireAssignmentEditor(dialog, () => service, branchWorkers);
  dialog.querySelector('#save').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await api(`/api/jobs/${job.id}/assignments`, { method: 'PUT', body: { expectedVersion: job.version, assignments: readAssignments(dialog) } }); closeModal(); toast('Assignments saved.'); await reload(app, job.id); }
    catch (error) { showError(error); button.disabled = false; }
  });
}

function pay(app, job) {
  const key = idempotencyKey(); // one key per payment attempt, reused on retry
  const dialog = modal({ title: 'Take payment', subtitle: `${job.code} · ${job.customerName}`,
    body: html`<form id="f" class="form-grid">
      <div class="full notice info">Amount due: <b>${money(job.finalPrice)} toman</b>. Split across methods if needed; tips are recorded separately.</div>
      ${PAYMENT_METHODS.map(m => html`<div><label for="m-${m.value}">${m.label}</label><input id="m-${m.value}" name="${m.value}" inputmode="numeric" pattern="[0-9]*" value="${m.value === 'card' ? job.finalPrice : ''}" placeholder="0"></div>`)}
      <div><label for="tip">Tip</label><input id="tip" name="tipAmount" inputmode="numeric" pattern="[0-9]*" placeholder="0"></div>
      <div><label for="tipm">Tip received by</label><select id="tipm" name="tipMethod">${options(PAYMENT_METHODS.filter(m => m.value !== 'customer_credit'), 'cash')}</select></div>
      <p class="full hint" id="pay-total"></p></form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" type="submit" class="primary">Record payment</button>` });
  const form = dialog.querySelector('#f');
  const total = () => PAYMENT_METHODS.reduce((s, m) => s + (Number(form.elements[m.value].value) || 0), 0);
  const update = () => { const t = total(); dialog.querySelector('#pay-total').textContent = t === job.finalPrice ? 'Parts match the amount due.' : `Parts total ${money(t)} — ${t < job.finalPrice ? 'short by' : 'over by'} ${money(Math.abs(job.finalPrice - t))} toman.`; };
  form.addEventListener('input', update); update();
  onSubmit(form, async data => {
    const parts = PAYMENT_METHODS.map(m => ({ method: m.value, amount: String(data[m.value] || '').trim() })).filter(p => p.amount && p.amount !== '0');
    await api(`/api/jobs/${job.id}/payments`, { method: 'POST', body: { parts, tipAmount: data.tipAmount || '0', tipMethod: data.tipMethod }, headers: { 'Idempotency-Key': key } });
    closeModal(); toast('Payment recorded. Job completed and commissions earned.');
    await reload(app, job.id);
  });
}

function edit(app, job) {
  const branch = app.branches.find(b => b.id === job.branchId);
  const dialog = modal({ title: 'Edit job', subtitle: job.code, body: html`<form id="f" class="form-grid">
    <div class="full"><label for="bay">Bay</label><select id="bay" name="bay">${options((branch?.bays || []).map(b => ({ value: b, label: b })), job.bay, { blank: 'Unassigned' })}</select></div>
    <div class="full"><label for="notes">Notes</label><textarea id="notes" name="notes" maxlength="500">${job.notes || ''}</textarea></div>
    <div class="full"><label for="dmg">Existing damage</label><textarea id="dmg" name="existingDamage" maxlength="500">${job.existingDamage || ''}</textarea></div></form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
  onSubmit(dialog.querySelector('#f'), async data => { await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { ...data, expectedVersion: job.version } }); closeModal(); toast('Job updated.'); await reload(app, job.id); });
}

function discount(app, job) {
  const limit = Math.floor(job.originalPrice * app.me.settings.discountApprovalBp / 10000);
  const dialog = modal({ title: 'Discount', subtitle: `${job.code} · discounts above ${money(limit)} toman need approval`, body: html`<form id="f" class="form-grid">
    <div><label for="d">Discount (toman)</label><input id="d" name="discount" inputmode="numeric" value="${job.discount}"></div>
    <div><label for="dr">Reason</label><input id="dr" name="discountReason" value="${job.discountReason || ''}" maxlength="200"></div></form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save discount</button>` });
  onSubmit(dialog.querySelector('#f'), async data => { await post(app, job, `/api/jobs/${job.id}/discount`, data); toast('Discount saved.'); });
}

function refund(app, job) {
  const dialog = modal({ title: 'Request refund', subtitle: `${job.code} · a second authorised person must approve it`, body: html`<form id="f" class="form-grid">
    <div><label for="ra">Amount (max ${money(job.refundable)})</label><input id="ra" name="amount" inputmode="numeric" value="${job.refundable}"></div>
    <div><label for="rm">Refund by</label><select id="rm" name="method">${options(PAYMENT_METHODS, job.payment?.parts[0]?.method || 'cash')}</select></div>
    <div class="full"><label for="rr">Reason</label><textarea id="rr" name="reason" required maxlength="300"></textarea></div>
    <p class="full hint">A full refund reverses the workers' commissions for this job.</p></form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" class="danger" type="submit">Submit request</button>` });
  onSubmit(dialog.querySelector('#f'), async data => { await api(`/api/jobs/${job.id}/refunds`, { method: 'POST', body: data }); closeModal(); toast('Refund requested for approval.'); await reload(app, job.id); });
}

async function newJob(app) {
  const [serviceList, workerList] = await Promise.all([services(), workers()]);
  const branchId = app.branchId;
  const branch = app.branches.find(b => b.id === branchId);
  const dialog = modal({ title: 'New job', subtitle: 'Prices and commission rates are locked in when the job is created.', wide: true, body: html`<form id="f" class="form-grid">
    <div><label for="plate">Plate *</label><input id="plate" name="plate" required maxlength="32" placeholder="21 ب 482 ایران 11"></div>
    <div><label for="vt">Vehicle type *</label><select id="vt" name="vehicleType">${options(VEHICLES, 'sedan')}</select></div>
    <div><label for="brand">Brand</label><input id="brand" name="brand" maxlength="40"></div><div><label for="model">Model</label><input id="model" name="model" maxlength="40"></div>
    <div><label for="cn">Customer name</label><input id="cn" name="customerName" maxlength="120" placeholder="Walk-in customer"></div><div><label for="cp">Customer phone</label><input id="cp" name="customerPhone" inputmode="tel"></div>
    <input type="hidden" name="customerId">
    <div class="full"><label for="svc">Service *</label><select id="svc" name="serviceId">${options(serviceList.map(s => ({ value: s.id, label: s.name })), serviceList[0]?.id)}</select></div>
    <div><label for="disc">Discount (toman)</label><input id="disc" name="discount" inputmode="numeric" value="0"></div><div><label for="dr">Discount reason</label><input id="dr" name="discountReason" maxlength="200"></div>
    <div><label for="bay">Bay</label><select id="bay" name="bay">${options((branch?.bays || []).map(b => ({ value: b, label: b })), '', { blank: 'Unassigned' })}</select></div>
    <div><label for="dmg">Existing damage</label><input id="dmg" name="existingDamage" maxlength="500"></div>
    <div class="full"><label for="notes">Notes</label><input id="notes" name="notes" maxlength="500"></div>
    <div class="full" id="quote" aria-live="polite"></div>
    ${app.can('jobs.assign') ? html`<div class="full"><h3>Workers (optional)</h3><div class="assign-rows"></div><button type="button" data-add-row>Add worker</button></div>` : ''}</form>`,
    footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create job</button>` });
  const form = dialog.querySelector('#f');
  const branchWorkers = workerList.filter(w => w.branchId === branchId);
  const currentService = () => serviceList.find(s => s.id === form.elements.serviceId.value);
  if (app.can('jobs.assign')) wireAssignmentEditor(dialog, currentService, branchWorkers);
  const refreshRoles = () => { const box = $('.assign-rows', dialog); if (box) box.innerHTML = String(assignmentRows(currentService(), branchWorkers, [])); };
  refreshRoles();
  const updateQuote = async () => {
    const data = formData(form);
    try {
      const q = await api('/api/jobs/quote', { method: 'POST', body: { serviceId: data.serviceId, vehicleType: data.vehicleType, discount: data.discount || '0' } });
      mount($('#quote', dialog), html`<div class="notice ${q.discountNeedsApproval ? '' : 'ok'}">Price ${money(q.originalPrice)} − discount ${money(q.discount)} = <b>${money(q.finalPrice)} toman</b>${q.discountNeedsApproval ? html` · discount above ${money(q.discountApprovalLimit)} needs approval before payment` : ''}</div>`);
    } catch (error) { mount($('#quote', dialog), html`<div class="notice">${error.message}</div>`); }
  };
  form.elements.serviceId.addEventListener('change', () => { refreshRoles(); updateQuote(); });
  form.elements.vehicleType.addEventListener('change', updateQuote);
  form.elements.discount.addEventListener('input', updateQuote);
  form.elements.plate.addEventListener('change', async () => {
    if (!app.can('customers.view') || !form.elements.plate.value.trim()) return;
    try {
      const found = await api(`/api/vehicles/lookup?plate=${encodeURIComponent(form.elements.plate.value)}`);
      if (!found) return;
      form.elements.vehicleType.value = found.vehicleType; form.elements.brand.value = found.brand || ''; form.elements.model.value = found.model || '';
      if (found.customer) { form.elements.customerName.value = found.customer.name; form.elements.customerPhone.value = found.customer.phone || ''; form.elements.customerId.value = found.customer.id; }
      toast('Known vehicle — details filled in.'); updateQuote();
    } catch { /* lookup is a convenience */ }
  });
  updateQuote();
  onSubmit(form, async data => {
    const body = { ...data, branchId, assignments: readAssignments(dialog) };
    if (!body.customerId) delete body.customerId;
    const job = await api('/api/jobs', { method: 'POST', body });
    closeModal(); toast(`${job.code} created.`);
    app.go(`jobs/${job.id}`);
  });
}

async function renderReceipt(target, jobId) {
  const r = await api(`/api/jobs/${jobId}/receipt`);
  mount(target, html`<div class="page-head no-print"><h1>Receipt</h1><div class="btn-row"><button type="button" id="back">Back</button><button type="button" id="print-a4">Print A4 / PDF</button><button type="button" class="primary" id="print-thermal">Print 80 mm</button></div></div>
    <article class="receipt"><div class="card-head"><div class="brand">SHINE<span>PRO</span></div>${pill(r.paymentStatus === 'paid' ? 'paid' : r.paymentStatus, r.paymentStatus)}</div>
      <small>${r.business} · ${r.branchName}</small><h2>${r.code}</h2>
      <div class="line"><span>Date</span><b>${dateTime(r.payment?.createdAt || r.createdAt)}</b></div>
      <div class="line"><span>Vehicle</span><b><span class="plate">${r.plate}</span></b></div>
      <div class="line"><span>Customer</span><b>${r.customerName}${r.customerPhone ? html` · ${r.customerPhone}` : ''}</b></div>
      <div class="line"><span>${r.serviceName}</span><b>${money(r.originalPrice)}</b></div>
      ${r.discount ? html`<div class="line"><span>Discount</span><b>−${money(r.discount)}</b></div>` : ''}
      <div class="line"><span><b>Total</b></span><b>${money(r.finalPrice)} toman</b></div>
      ${(r.payment?.parts || []).map(p => html`<div class="line"><span>${methodLabel(p.method)}</span><b>${money(p.amount)}</b></div>`)}
      ${r.payment?.tipAmount ? html`<div class="line"><span>Tip — thank you</span><b>${money(r.payment.tipAmount)}</b></div>` : ''}
      ${r.refunds.filter(x => x.status === 'approved').map(x => html`<div class="line"><span>Refund</span><b>−${money(x.amount)}</b></div>`)}
      <p class="hint">Reference ${r.payment?.id?.slice(0, 8).toUpperCase() || '—'} · Keep this receipt for your records.</p></article>`);
  const print = thermal => { document.body.classList.toggle('thermal', thermal); window.print(); };
  $('#back').addEventListener('click', () => history.back());
  $('#print-a4').addEventListener('click', () => print(false));
  $('#print-thermal').addEventListener('click', () => print(true));
}

