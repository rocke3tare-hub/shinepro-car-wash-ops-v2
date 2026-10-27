import { html, toman, raw } from '../assets/ui.js';

const TONES = {
  waiting: 'amber', assigned: 'amber', in_progress: '', paused: 'grey', ready_for_quality: 'amber', rework_required: 'red',
  ready_for_payment: 'green', completed: 'green', cancelled: 'grey', refunded: 'red',
  pending: 'amber', approved: 'green', rejected: 'red', withdrawn: 'grey', submitted: 'amber', paid: 'green',
  open: 'green', closed: 'grey', review_required: 'red', reviewed: 'green', unpaid: 'amber'
};
export const pill = (status, label = status.replaceAll('_', ' ')) => html`<span class="pill ${TONES[status] ?? ''}">${label}</span>`;
export const selected = condition => condition ? raw('selected') : '';
export const checked = condition => condition ? raw('checked') : '';
export const disabled = condition => condition ? raw('disabled') : '';
export const options = (list, current, { value = x => x.value, label = x => x.label, blank = null } = {}) =>
  html`${blank !== null ? html`<option value="">${blank}</option>` : ''}${list.map(item => html`<option value="${value(item)}" ${selected(String(value(item)) === String(current ?? ''))}>${label(item)}</option>`)}`;
export const amountCell = value => html`<td class="num">${toman(value)}</td>`;
export const PAYMENT_METHODS = [{ value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'customer_credit', label: 'Customer credit' }];
export const methodLabel = m => PAYMENT_METHODS.find(x => x.value === m)?.label || m;
export function branchOptions(app) { return app.branches.map(b => ({ value: b.id, label: b.name })); }
