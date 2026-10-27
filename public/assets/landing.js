import { api, html, mount, modal, closeModal, onSubmit, money, $, toast, initLanguage, setLanguage } from './ui.js';

let lang = initLanguage();
$('#lang-toggle').addEventListener('click', () => { lang = lang === 'fa' ? 'en' : 'fa'; setLanguage(lang); toast(lang === 'fa' ? 'حالت راست‌به‌چپ فعال شد' : 'English layout'); });

async function loadCatalog() {
  try {
    const data = await api('/api/public/catalog', { redirectOn401: false });
    mount('#service-grid', data.services.length ? data.services.map((s, i) => html`<article class="service-card">
      <span class="eyebrow">${String(i + 1).padStart(2, '0')} / Care</span><h3>${s.name}</h3>
      <p class="muted">${s.description || 'Professional care configured for your vehicle size.'}</p>
      <div class="line"><span>${s.durationMinutes} min</span><span class="price">From ${money(s.fromPrice)} toman</span></div></article>`) : html`<p class="muted">Services will be listed here soon.</p>`);
    if (data.offers.length) mount('#offer-grid', data.offers.map(o => html`<article class="offer"><p class="eyebrow">${o.label || 'Offer'}</p><h3>${o.title}</h3><p>${o.description || ''}</p></article>`));
    else $('#offers-section').classList.add('hidden');
  } catch {
    mount('#service-grid', html`<p class="muted">Services are unavailable right now. Please try again shortly.</p>`);
    $('#offers-section').classList.add('hidden');
  }
}

function openAuth(mode) {
  const dialog = modal({
    title: mode === 'signup' ? 'Create your account' : 'Welcome back',
    subtitle: mode === 'signup' ? 'One account for your vehicles, visits, receipts and rewards.' : 'Sign in to your member portal or staff workspace.',
    body: html`<div class="auth-tabs"><button type="button" data-mode="signup" class="${mode === 'signup' ? 'active' : ''}">Create account</button><button type="button" data-mode="login" class="${mode === 'login' ? 'active' : ''}">Sign in</button></div>
      ${mode === 'signup' ? html`<form id="auth-form" class="form-grid" novalidate>
        <div class="full"><label for="f-name">Full name</label><input id="f-name" name="displayName" autocomplete="name" required maxlength="80"></div>
        <div><label for="f-phone">Mobile</label><input id="f-phone" name="phone" autocomplete="tel" inputmode="tel" required></div>
        <div><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" required></div>
        <div class="full"><label for="f-pass">Password</label><input id="f-pass" name="password" type="password" autocomplete="new-password" minlength="10" required><p class="hint">At least 10 characters.</p></div>
        <label class="check full"><input type="checkbox" name="marketingOptIn"> Send me member offers</label>
        <input type="hidden" name="language" value="${lang}">
        <div class="full"><button class="primary" type="submit">Create account</button></div></form>`
      : html`<form id="auth-form" class="form-grid" novalidate>
        <div class="full"><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="username" required></div>
        <div class="full"><label for="f-pass">Password</label><input id="f-pass" name="password" type="password" autocomplete="current-password" required></div>
        <div class="full"><button class="primary" type="submit">Sign in</button></div></form>`}`
  });
  dialog.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => openAuth(b.dataset.mode)));
  onSubmit(dialog.querySelector('#auth-form'), async data => {
    if (mode === 'signup') { await api('/api/auth/signup', { method: 'POST', body: data, redirectOn401: false }); location.href = '/portal'; return; }
    const result = await api('/api/auth/login', { method: 'POST', body: data, redirectOn401: false });
    closeModal();
    location.href = result.destination;
  });
}

document.querySelectorAll('[data-auth]').forEach(button => button.addEventListener('click', () => openAuth(button.dataset.auth)));
if (new URLSearchParams(location.search).has('signin')) openAuth('login');
loadCatalog();
