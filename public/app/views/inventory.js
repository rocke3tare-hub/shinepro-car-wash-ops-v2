import { api, html, mount, modal, closeModal, onSubmit, toast, toman, dateTime, $, $$ } from '../../assets/ui.js';
import { pill, options } from '../common.js';

const KINDS = [['purchase', 'Purchase (in)'], ['return', 'Return (in)'], ['usage', 'Usage (out)'], ['waste', 'Waste (out)'], ['adjustment', 'Adjustment (±)']].map(([value, label]) => ({ value, label }));
let filter = 'all';

export async function render(target, app) {
  const items = await api(`/api/inventory?filter=${filter}`);
  const canManage = app.can('inventory.manage');
  mount(target, html`<div class="page-head"><div><h1>Inventory</h1><p>Stock is the sum of recorded movements and can never go below zero.</p></div>
      <div class="btn-row">${canManage ? html`<button class="primary" type="button" id="new">New item</button>` : ''}</div></div>
    <div class="tabs">${[['all', 'All'], ['low', 'Low stock'], ['active', 'Active'], ['inactive', 'Inactive']].map(([v, l]) => html`<button type="button" data-f="${v}" class="${filter === v ? 'active' : ''}">${l}</button>`)}</div>
    <section class="card">${items.length ? html`<div class="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th class="num">Stock</th><th class="num">Minimum</th><th class="num">Unit cost</th><th>Last movement</th><th></th></tr></thead><tbody>
      ${items.map(i => html`<tr><td><b>${i.name}</b> ${i.low ? pill('rework_required', 'low') : ''}${i.status === 'inactive' ? pill('cancelled', 'inactive') : ''}</td><td>${i.category}</td><td class="num">${i.stock} ${i.unit}</td><td class="num">${i.minimumStock} ${i.unit}</td><td class="num">${toman(i.unitCost)}</td>
        <td>${i.lastMovement ? html`${i.lastMovement.kind} ${i.lastMovement.quantity}<br><small>${dateTime(i.lastMovement.created_at)}</small>` : '—'}</td>
        <td>${canManage ? html`<div class="btn-row">${i.status === 'active' ? html`<button type="button" data-move="${i.id}">Movement</button>` : ''}<button type="button" data-edit="${i.id}">Edit</button></div>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No items.</p>`}</section>`);
  const done = msg => { closeModal(); toast(msg); render(target, app); };
  $$('[data-f]', target).forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; render(target, app); }));
  $('#new', target)?.addEventListener('click', () => {
    const d = modal({ title: 'New inventory item', body: html`<form id="f" class="form-grid">
      <div class="full"><label for="n">Name</label><input id="n" name="name" required maxlength="80"></div>
      <div><label for="c">Category</label><input id="c" name="category" value="Supplies"></div><div><label for="u">Unit</label><input id="u" name="unit" required placeholder="L, pcs, kg"></div>
      <div><label for="m">Minimum stock</label><input id="m" name="minimumStock" inputmode="numeric" value="0"></div><div><label for="uc">Unit cost</label><input id="uc" name="unitCost" inputmode="numeric" value="0"></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Create</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api('/api/inventory', { method: 'POST', body: { ...data, branchId: app.branchId } }); done('Item created.'); });
  });
  $$('[data-move]', target).forEach(b => b.addEventListener('click', () => {
    const item = items.find(i => i.id === b.dataset.move);
    const d = modal({ title: 'Stock movement', subtitle: `${item.name} · ${item.stock} ${item.unit} in stock`, body: html`<form id="f" class="form-grid">
      <div><label for="k">Type</label><select id="k" name="kind">${options(KINDS, 'usage')}</select></div><div><label for="q">Quantity</label><input id="q" name="quantity" inputmode="numeric" required><p class="hint">For adjustments use a negative number to reduce.</p></div>
      <div><label for="uc">Unit cost (purchases)</label><input id="uc" name="unitCost" inputmode="numeric" value="${item.unitCost}"></div><div><label for="r">Reason</label><input id="r" name="reason" required maxlength="200"></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Record</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/inventory/${item.id}/movements`, { method: 'POST', body: data }); done('Movement recorded.'); });
  }));
  $$('[data-edit]', target).forEach(b => b.addEventListener('click', () => {
    const item = items.find(i => i.id === b.dataset.edit);
    const d = modal({ title: 'Edit item', subtitle: item.name, body: html`<form id="f" class="form-grid">
      <div><label for="c">Category</label><input id="c" name="category" value="${item.category}"></div><div><label for="m">Minimum stock</label><input id="m" name="minimumStock" inputmode="numeric" value="${item.minimumStock}"></div>
      <div><label for="uc">Unit cost</label><input id="uc" name="unitCost" inputmode="numeric" value="${item.unitCost}"></div><div><label for="s">Status</label><select id="s" name="status">${options([{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], item.status)}</select></div></form>`,
      footer: html`<button type="button" data-close>Cancel</button><button form="f" class="primary" type="submit">Save</button>` });
    onSubmit(d.querySelector('#f'), async data => { await api(`/api/inventory/${item.id}`, { method: 'PATCH', body: data }); done('Item updated.'); });
  }));
}
