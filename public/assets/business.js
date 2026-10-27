import { api, onSubmit, $, initLanguage } from './ui.js';

initLanguage();
onSubmit($('#business-form'), async (data, form) => {
  await api('/api/business-registrations', { method: 'POST', body: data, redirectOn401: false });
  form.reset();
  form.classList.add('hidden');
  $('#business-done').classList.remove('hidden');
});
