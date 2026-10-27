import { api, html, mount, toman, compact, minutesSince, $$ } from '../../assets/ui.js';
import { pill } from '../common.js';

export async function render(target, app) {
  const canReports = app.can('reports.view');
  const [summary, open] = await Promise.all([
    canReports ? api('/api/reports/summary') : null,
    api('/api/jobs?status=open&limit=50')
  ]);
  const count = status => open.filter(j => j.status === status).length;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const m = summary?.metrics;
  mount(target, html`
    <div class="page-head"><div><h1>${greeting}, ${app.me.user.displayName.split(' ')[0]}</h1><p>${canReports ? 'Today at a glance.' : 'Your current work.'}</p></div>
      <div class="btn-row">${app.can('jobs.create') ? html`<button class="primary" type="button" data-go="jobs">Open jobs</button>` : ''}</div></div>
    <div class="metrics">
      <div class="metric"><span>Open jobs</span><strong>${open.length}</strong><small>${count('waiting')} waiting · ${count('in_progress')} in progress</small></div>
      <div class="metric ${count('ready_for_quality') ? 'warn' : ''}"><span>Awaiting quality</span><strong>${count('ready_for_quality')}</strong><small>${count('rework_required')} in rework</small></div>
      <div class="metric"><span>Ready for payment</span><strong>${count('ready_for_payment')}</strong></div>
      ${m ? html`<div class="metric"><span>Revenue today</span><strong>${compact(m.netRevenue)}</strong><small>${m.jobsPaid} paid · avg ${compact(m.averageTicket)}</small></div>
        <div class="metric"><span>Estimated profit</span><strong>${compact(m.estimatedProfit)}</strong><small>after commissions & expenses</small></div>
        <div class="metric"><span>Branch score</span><strong>${summary.score.score ?? '—'}</strong><small>${summary.score.classification} · ${summary.score.completeness}% data</small></div>` : ''}
    </div>
    <section class="card"><div class="card-head"><h3>Live queue</h3><button type="button" data-go="jobs">All jobs</button></div>
      ${open.length ? html`<div class="table-wrap"><table><thead><tr><th>Job</th><th>Vehicle</th><th>Service</th><th>Waiting</th><th>Status</th><th class="num">Price</th></tr></thead><tbody>
        ${open.slice(0, 12).map(j => html`<tr class="clickable" data-job="${j.id}"><td class="job-code">${j.code}</td><td><span class="plate">${j.plate}</span></td><td>${j.serviceName}</td><td>${minutesSince(j.createdAt)} min</td><td>${pill(j.status, j.statusLabel)}</td><td class="num">${toman(j.finalPrice)}</td></tr>`)}</tbody></table></div>`
      : html`<p class="empty">No open jobs right now.</p>`}</section>`);
  $$('[data-go]', target).forEach(b => b.addEventListener('click', () => app.go(b.dataset.go)));
  $$('[data-job]', target).forEach(r => r.addEventListener('click', () => app.go(`jobs/${r.dataset.job}`)));
}
