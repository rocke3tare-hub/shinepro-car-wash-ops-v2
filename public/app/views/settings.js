import { api, html, mount, modal, closeModal, onSubmit, toast, money, $, $$ } from '../../assets/ui.js';
import { options } from '../common.js';

const TYPES = [['small', 'Small'], ['sedan', 'Sedan'], ['suv', 'SUV'], ['van', 'Van']];

export async function render(target, app) {
  const manage = app.can('settings.manage');
  const [services, settings] = await Promise.all([manage ? api('/api/services?all=1') : [], api('/api/settings')]);
  mount(target, html`<div class="page-head"><div><h1>Settings</h1><p>${manage ? 'Price and commission changes create a new version; existing jobs keep the snapshot they were created with.' : 'Your account.'}</p></div></div>
    <div class="grid two">
      <section class="card"><h3>Your password</h3><form id="pw" class="form-grid">
        <div class="full"><label for="cur">Current password</label><input id="cur" name="currentPassword" type="password" autocomplete="current-password" required></div>
        <div class="full"><label for="new">New password</label><input id="new" name="newPassword" type="password" autocomplete="new-password" minlength="10" required><p class="hint">At least 10 characters. You will be signed out everywhere.</p></div>
        <div class="full"><button type="submit">Change password</button></div></form></section>
      ${manage ? html`<section class="card"><h3>Business rules</h3><form id="biz" class="form-grid">
        <div><label for="dab">Discount approval above (%)</label><input id="dab" name="discountApprovalPct" inputmode="decimal" value="${settings.discountApprovalBp / 100}"></div>
        <div><label for="crt">Cash review above (toman)</label><input id="crt" name="cashReviewThreshold" inputmode="numeric" value="${settings.cashReviewThreshold}"></div>
        <div><label for="lp">Toman per loyalty point</label><input id="lp" name="loyaltyTomanPerPoint" inputmode="numeric" value="${settings.loyaltyTomanPerPoint}"></div>
        <div><label for="rt">Daily revenue target</label><input id="rt" name="revenueTargetDaily" inputmode="numeric" value="${settings.revenueTargetDaily}"></div>
        <div><label for="jp">Job code prefix</label><input id="jp" name="jobCodePrefix" maxlength="6" value="${settings.jobCodePrefix}"></div>
        <div class="full"><button class="primary" type="submit">Save rules</button></div></form></section>` : ''}
    </div>
    ${manage ? html`<section class="card"><div class="card-head"><h3>Services, prices and commission</h3><button type="button" class="primary" id="new-svc">New service</button></div>
      <div class="table-wrap"><table><thead><tr><th>Service</th>${TYPES.map(([, l]) => html`<th class="num">${l}</th>`)}<th>Commission</th><th></th></tr></thead><tbody>
      ${services.map(s => html`<tr><td><b>${s.name}</b>${s.status === 'archived' ? html` <span class="pill grey">archived</span>` : ''}<br><small>${s.durationMinutes} min · ${s.checklist.length} checks</small></td>
        ${TYPES.map(([k]) => html`<td class="num">${s.prices[k] == null ? html`<small>not offered</small>` : money(s.prices[k])}</td>`)}
        <td>${s.commission ? html`${s.commission.rules.map(r => html`<small>${r.role} ${(r.basisPoints / 100).toFixed(2)}%</small><br>`)}<small>pool ≤ ${(s.commission.poolLimitBp / 100).toFixed(2)}%</small>` : '—'}</td>
        <td><div class="btn-row"><button type="button" data-prices="${s.id}">Prices</button><button type="button" data-rules="${s.id}">Commission</button><button type="button" data-edit="${s.id}">Details</button></div></td></tr>`)}</tbody></table></div></section>` : ''}`);

  onSubmit($('#pw', target), async data => { await api('/api/auth/password', { method: 'POST', body: data }); toast('Password changed. Please sign in again.'); setTimeout(() => { location.href = '/?signin=1'; }, 800); });
  if (!manage) return;
  const done = msg => { closeModal(); toast(msg); render(target, app); };
  onSubmit($('#biz', target), async data => {
    const pct = String(data.discountApprovalPct).trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(pct) || Number(pct) > 100) throw new Error('Discount threshold must be a percentage between 0 and 100 with at most two decimals.');
    const { discountApprovalPct, ...rest } = data;
    await api('/api/settings', { method: 'PATCH', body: { ...rest, discountApprovalBp: String(Math.round(Number(pct) * 100)) } });
    toast('Business rules saved.');
  });
  const priceInputs = s => html`${TYPES.map(([k, l]) => html`<div><label for="p-${k}">${l}</label><input id="p-${k}" name="${k}" inputmode="numeric" value="${s?.prices[k] ?? ''}" placeholder="not offered"></div>`)}`;
  const ruleRows = rules => html`<div class="rules">${(rules.length ? rules : [{ role: '', basisPoints: '' }]).map(r => html`<div class="assign-row"><input name="role" placeholder="Role" value="${r.role}" aria-label="Role"><input name="pct" placeholder="%" inputmode="decimal" value="${r.basisPoints === '' ? '' : r.basisPoints / 100}" aria-label="Percent"><button type="button" class="icon-btn" data-remove aria-label="Remove">−</button></div>`)}</div><button type="button" data-add>Add role</button>`;
  const toBp = (value, label) => { const v = String(value).trim(); if (!/^\d{1,3}(\.\d{1,2})?$/.test(v) || Number(v) > 100) throw new Error(`${label} must be a percentage with at most two decimals.`); return String(Math.round(Number(v) * 100)); };
  const readRules = root => $$('.rules .assign-row', root).map(row => ({ role: row.querySelector('[name=role]').value, pct: row.querySelector('[name=pct]').value })).filter(r => r.role || r.pct).map(r => ({ role: r.role, basisPoints: toBp(r.pct, `Rate for ${r.role || 'role'}`) }));
  const wireRules = root => root.addEventListener('click', e => {
    if (e.target.closest('[data-remove]')) e.target.closest('.assign-row').remove();
    if (e.target.closest('[data-add]')) $('.rules', root).insertAdjacentHTML('beforeend', String(html`<div class="assign-row"><input name="role" placeholder="Role" aria-label="Role"><input name="pct" placeholder="%" inputmode="decimal" aria-label="Percent"><button type="button" class="icon-btn" data-remove aria-label="Remove">−</button></div>`));
  });
  const prices = data => Object.fromEntries(TYPES.map(([k]) => [k, String(data[k] || '').trim()]).filter(([, v]) => v));

  $$('[data-prices]', target).forEach(b => b.addEventListener('click', () => {
    const s = services.find(x => x.id === b.dataset.prices);
    const d = modal({ title: `Prices · ${s.name}`, subtitle: 'Enter only the prices that change. Leave blank to keep the current price.', body: html`<form id="f" class="form-grid">${priceInputs(s)}</form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save new prices</button>` });
    onSubmit(d.querySelector('#f'), async data => {
      const changed = Object.fromEntries(Object.entries(prices(data)).filter(([k, v]) => Number(v) !== s.prices[k]));
      await api(`/api/services/${s.id}/prices`, { method: 'POST', body: { prices: changed } }); done('New price version saved.');
    });
  }));
  $$('[data-rules]', target).forEach(b => b.addEventListener('click', () => {
    const s = services.find(x => x.id === b.dataset.rules);
    const d = modal({ title: `Commission · ${s.name}`, subtitle: 'Rates are a percentage of the job’s final (discounted) price.', wide: true, body: html`<form id="f">${ruleRows(s.commission?.rules || [])}
      <label for="pool">Pool limit (% of price)</label><input id="pool" name="pool" inputmode="decimal" value="${(s.commission?.poolLimitBp ?? 3000) / 100}"></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save new version</button>` });
    wireRules(d);
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/services/${s.id}/commission`, { method: 'POST', body: { rules: readRules(d), poolLimitBp: toBp(data.pool, 'Pool limit') } }); done('Commission rules saved.'); });
  }));
  $$('[data-edit]', target).forEach(b => b.addEventListener('click', () => {
    const s = services.find(x => x.id === b.dataset.edit);
    const d = modal({ title: s.name, body: html`<form id="f" class="form-grid">
      <div class="full"><label for="ds">Description</label><textarea id="ds" name="description" maxlength="400">${s.description || ''}</textarea></div>
      <div><label for="du">Duration (minutes)</label><input id="du" name="durationMinutes" inputmode="numeric" value="${s.durationMinutes}"></div>
      <div><label for="st">Status</label><select id="st" name="status">${options([{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }], s.status)}</select></div>
      <div class="full"><label for="ck">Quality checklist (one item per line)</label><textarea id="ck" name="checklist">${s.checklist.join('\n')}</textarea></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/services/${s.id}`, { method: 'PATCH', body: data }); done('Service updated.'); });
  }));
  $('#new-svc', target).addEventListener('click', () => {
    const d = modal({ title: 'New service', wide: true, body: html`<form id="f" class="form-grid">
      <div><label for="nm">Name</label><input id="nm" name="name" required maxlength="80"></div><div><label for="du">Duration (minutes)</label><input id="du" name="durationMinutes" inputmode="numeric" value="30"></div>
      <div class="full"><label for="ds">Description</label><input id="ds" name="description" maxlength="400"></div>
      ${priceInputs(null)}
      <div class="full"><label for="ck">Quality checklist (one per line)</label><textarea id="ck" name="checklist"></textarea></div>
      <div class="full"><h3>Commission roles</h3>${ruleRows([])}<label for="pool">Pool limit (%)</label><input id="pool" name="pool" inputmode="decimal" value="30"></div></form>`, footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create service</button>` });
    wireRules(d);
    onSubmit(d.querySelector('#f'), async data => {
      await api('/api/services', { method: 'POST', body: { name: data.name, description: data.description, durationMinutes: data.durationMinutes, checklist: data.checklist, prices: prices(data), commission: { rules: readRules(d), poolLimitBp: toBp(data.pool, 'Pool limit') } } });
      done('Service created.');
    });
  });
}
