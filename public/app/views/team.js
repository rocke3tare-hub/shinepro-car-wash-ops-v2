import { api, html, mount, modal, closeModal, onSubmit, toast, dateTime, $, $$, showError } from '../../assets/ui.js';
import { pill, options, checked } from '../common.js';

export async function render(target, app) {
  const [workers, staff] = await Promise.all([app.can('workers.manage') ? api('/api/workers?all=1') : [], app.can('staff.manage') ? api('/api/staff') : null]);
  const branchName = id => app.branches.find(b => b.id === id)?.name || 'All branches';
  mount(target, html`<div class="page-head"><div><h1>Team</h1><p>Workers on the floor and the people who can sign in.</p></div>
      <div class="btn-row">${app.can('workers.manage') ? html`<button type="button" id="new-worker">Add worker</button>` : ''}${staff ? html`<button class="primary" type="button" id="new-staff">Give someone access</button>` : ''}</div></div>
    ${app.can('workers.manage') ? html`<section class="card"><h3>Workers</h3><div class="table-wrap"><table><thead><tr><th>Name</th><th>Title</th><th>Branch</th><th>Shift</th><th>Status</th><th></th></tr></thead><tbody>
      ${workers.map(w => html`<tr><td><b>${w.name}</b><br><small>${w.phone || ''}${w.userId ? ' · has sign-in' : ''}</small></td><td>${w.title}</td><td>${branchName(w.branchId)}</td><td>${pill(w.onShift ? 'open' : 'closed', w.onShift ? 'on shift' : 'off')}</td><td>${pill(w.status === 'active' ? 'approved' : 'cancelled', w.status)}</td>
        <td><div class="btn-row"><button type="button" data-shift="${w.id}">${w.onShift ? 'End shift' : 'Start shift'}</button><button type="button" data-edit="${w.id}">Edit</button></div></td></tr>`)}</tbody></table></div></section>` : ''}
    ${staff ? html`<section class="card"><h3>Sign-in access</h3><div class="table-wrap"><table><thead><tr><th>Person</th><th>Roles</th><th>Last sign-in</th></tr></thead><tbody>
      ${staff.users.map(u => html`<tr><td><b>${u.displayName}</b><br><small>${u.email}</small></td><td>${u.roles.length ? u.roles.map(r => html`<span class="pill grey">${r.label} · ${branchName(r.branchId)}</span> ${r.role !== 'owner' && u.id !== app.me.user.id ? html`<button type="button" class="ghost danger" data-revoke="${r.membershipId}" aria-label="Revoke ${r.label}">×</button>` : ''} `) : html`<small>No active role</small>`}</td><td>${dateTime(u.lastLoginAt)}</td></tr>`)}
      </tbody></table></div></section>` : ''}`);
  const done = msg => { closeModal(); toast(msg); render(target, app); };
  const workerForm = w => html`<form id="f" class="form-grid">
    <div class="full"><label for="n">Name</label><input id="n" name="name" required maxlength="80" value="${w?.name || ''}"></div>
    <div><label for="t">Title</label><input id="t" name="title" maxlength="60" value="${w?.title || 'Car-wash worker'}"></div><div><label for="p">Phone</label><input id="p" name="phone" value="${w?.phone || ''}"></div>
    ${w ? html`<div><label for="s">Status</label><select id="s" name="status">${options([{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }], w.status)}</select></div><label class="check"><input type="checkbox" name="onShift" ${checked(w.onShift)}> On shift</label>`
      : html`<div class="full"><label for="b">Branch</label><select id="b" name="branchId">${options(app.branches.map(b => ({ value: b.id, label: b.name })), app.branchId)}</select></div>`}</form>`;
  $('#new-worker', target)?.addEventListener('click', () => {
    const d = modal({ title: 'Add worker', subtitle: 'Workers without sign-in can still be assigned to jobs and earn commission.', body: workerForm(null), footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Add</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/workers', { method: 'POST', body: data }); done('Worker added.'); });
  });
  $$('[data-edit]', target).forEach(b => b.addEventListener('click', () => {
    const w = workers.find(x => x.id === b.dataset.edit);
    const d = modal({ title: 'Edit worker', body: workerForm(w), footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/workers/${w.id}`, { method: 'PATCH', body: data }); done('Worker updated.'); });
  }));
  $$('[data-shift]', target).forEach(b => b.addEventListener('click', async () => {
    const w = workers.find(x => x.id === b.dataset.shift);
    b.disabled = true;
    try { await api(`/api/workers/${w.id}`, { method: 'PATCH', body: { onShift: !w.onShift } }); render(target, app); } catch (error) { showError(error); b.disabled = false; }
  }));
  $$('[data-revoke]', target).forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Revoke this role? The person loses this access immediately.')) return;
    try { await api(`/api/staff/roles/${b.dataset.revoke}`, { method: 'DELETE' }); done('Role revoked.'); } catch (error) { showError(error); }
  }));
  $('#new-staff', target)?.addEventListener('click', () => {
    const d = modal({ title: 'Give someone access', subtitle: 'A one-time password is shown once; share it privately.', body: html`<form id="f" class="form-grid">
      <div><label for="n">Name</label><input id="n" name="displayName" required maxlength="80"></div><div><label for="e">Work email</label><input id="e" name="email" type="email" required></div>
      <div><label for="r">Role</label><select id="r" name="role">${options(staff.assignableRoles.map(r => ({ value: r.role, label: r.label })), 'cashier')}</select></div>
      <div><label for="b">Branch</label><select id="b" name="branchId">${options(app.branches.map(b => ({ value: b.id, label: b.name })), app.branchId, { blank: 'All branches (admins, accountants)' })}</select></div>
      <div class="full"><label for="p">Phone</label><input id="p" name="phone"></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create access</button>` });
    onSubmit(d.querySelector('#f'), async data => {
      const result = await api('/api/staff', { method: 'POST', body: data });
      closeModal();
      if (result.temporaryPassword) modal({ title: 'Access created', body: html`<p>Share these sign-in details privately. The password is not shown again.</p><div class="line"><span>Email</span><b>${result.email}</b></div><div class="line"><span>Temporary password</span><b>${result.temporaryPassword}</b></div><p class="hint">Ask them to change it from Settings after signing in.</p>`, footer: html`<button type="button" class="primary" data-close>Done</button>` });
      else toast('Role added to the existing account.');
      render(target, app);
    });
  });
}
