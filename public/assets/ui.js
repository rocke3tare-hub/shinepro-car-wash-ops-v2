// Shared browser helpers. Every dynamic value goes through html`` which
// escapes it; only values wrapped in raw() (our own markup) are inserted as-is.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const escape = value => String(value ?? '').replace(/[&<>"'`]/g, ch => ESCAPES[ch]);

class Raw { constructor(value) { this.value = value; } toString() { return this.value; } }
export const raw = value => new Raw(String(value ?? ''));

function render(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === false || value === null || value === undefined) return '';
  return escape(value);
}

/** Tagged template: html`<b>${name}</b>` -> Raw with name escaped. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => { out += render(value) + strings[i + 1]; });
  return new Raw(out);
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export function mount(target, content) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.innerHTML = render(content);
  return node;
}

export const money = value => value == null ? '—' : `${Number(value).toLocaleString('en-US')}`;
export const toman = value => value == null ? '—' : html`${money(value)} <small class="unit">toman</small>`;
export const compact = value => {
  const n = Number(value || 0);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
};
export const dateTime = iso => iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const timeOnly = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
export const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
export const minutesSince = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

export class ApiError extends Error {
  constructor(status, body) { super(body?.message || `Request failed (${status})`); this.status = status; this.code = body?.error; this.details = body?.details; }
}

/** JSON API client. Redirects to the sign-in page when the session has ended. */
export async function api(path, { method = 'GET', body, headers = {}, redirectOn401 = true } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const payload = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && redirectOn401) location.href = '/?signin=1';
    throw new ApiError(response.status, payload);
  }
  return payload?.data;
}

export const idempotencyKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function toast(message, kind = 'ok') {
  let wrap = $('#toasts');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toasts'; wrap.setAttribute('aria-live', 'polite'); document.body.append(wrap); }
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  wrap.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3500);
}

export const showError = error => toast(error?.message || 'Something went wrong.', 'error');

let lastFocus = null;
/** Accessible modal. body/footer are html`` values. Returns the dialog element. */
export function modal({ title, subtitle = '', body, footer = '', wide = false }) {
  closeModal();
  lastFocus = document.activeElement;
  const layer = document.createElement('div');
  layer.className = 'modal-layer';
  layer.innerHTML = render(html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <header class="modal-head"><div><h2 id="modal-title">${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : ''}</div>
    <button class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="modal-body">${body}</div>${footer ? html`<footer class="modal-foot">${footer}</footer>` : ''}</div>`);
  layer.addEventListener('click', event => { if (event.target === layer || event.target.closest('[data-close]')) closeModal(); });
  layer.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
  document.body.append(layer);
  setTimeout(() => (layer.querySelector('input:not([type=hidden]), select, textarea, button.primary') || layer.querySelector('button'))?.focus(), 20);
  return layer.querySelector('.modal');
}
export function closeModal() {
  $$('.modal-layer').forEach(node => node.remove());
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

/** Collect a form as a plain object; checkboxes become booleans. */
export function formData(form) {
  const data = {};
  for (const element of form.elements) {
    if (!element.name || element.disabled) continue;
    if (element.type === 'checkbox') data[element.name] = element.checked;
    else if (element.type === 'radio') { if (element.checked) data[element.name] = element.value; }
    else data[element.name] = element.value;
  }
  return data;
}

/** Wire a form: disable while submitting, show field errors, run handler. */
export function onSubmit(form, handler) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const buttons = $$('button[type=submit], button:not([type])', form.closest('.modal') || form);
    buttons.forEach(b => { b.disabled = true; });
    $$('.field-error', form).forEach(n => n.remove());
    try { await handler(formData(form), form); }
    catch (error) {
      const field = error?.details?.field && form.elements[error.details.field];
      if (field) field.insertAdjacentHTML('afterend', render(html`<span class="field-error">${error.message}</span>`));
      showError(error);
    } finally { buttons.forEach(b => { b.disabled = false; }); }
  });
}

export function setLanguage(lang) {
  document.documentElement.lang = lang === 'fa' ? 'fa' : 'en';
  document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  try { localStorage.setItem('sp-lang', lang); } catch { /* storage unavailable */ }
}
export function initLanguage() {
  let lang = 'en';
  try { lang = localStorage.getItem('sp-lang') || 'en'; } catch { /* ignore */ }
  setLanguage(lang);
  return lang;
}
