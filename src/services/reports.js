import { invalid } from '../lib/errors.js';
import { isoDate, oneOf, id as idField } from '../lib/validate.js';
import { ACCOUNTS, accountBalance } from '../domain/ledger.js';
import { branchScore } from '../domain/scoring.js';
import { STATUS_LABELS } from '../domain/jobs.js';
import { CATEGORY_LABELS } from './expenses.js';
import { listEarnings } from './earnings.js';
import { branchFilter, requireBranch, requirePermission, settings } from './common.js';
import { workbook, csv } from '../lib/xlsx.js';

/** Offset (ms) of a time zone from UTC at a given instant. */
function zoneOffset(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(instant)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
}

/** UTC instant of local midnight on dateStr (YYYY-MM-DD) in timeZone. */
export function zonedMidnight(dateStr, timeZone) {
  const guess = Date.parse(`${dateStr}T00:00:00Z`);
  let result = guess - zoneOffset(guess, timeZone);
  result = guess - zoneOffset(result, timeZone); // second pass handles DST edges
  return result;
}

export function localDate(timeZone, instant = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

/** Resolve [from, to] calendar days in the business time zone into a UTC window. */
function window(input, timeZone = 'Asia/Tehran') {
  const today = localDate(timeZone);
  const from = isoDate(input.from || today, 'From date');
  const to = isoDate(input.to || from, 'To date');
  if (to < from) throw invalid('The end date is before the start date.');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > 366) throw invalid('Reports cover at most one year.');
  const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { from, to, start: new Date(zonedMidnight(from, timeZone)).toISOString(), end: new Date(zonedMidnight(next, timeZone)).toISOString(), days, timeZone };
}

function businessZone(ctx) {
  return ctx.db.get(`SELECT timezone FROM branches WHERE business_id = :business ORDER BY created_at LIMIT 1`, { business: ctx.actor.businessId })?.timezone || 'Asia/Tehran';
}

function scoped(ctx, input, column) {
  const scope = branchFilter(ctx, column);
  const params = { business: ctx.actor.businessId, ...scope.params };
  let sql = scope.sql;
  if (input.branchId) {
    params.branch = idField(input.branchId, 'Branch');
    requireBranch(ctx, params.branch);
    sql += ` AND ${column} = :branch`;
  }
  return { sql, params };
}

export function summary(ctx, input = {}) {
  requirePermission(ctx, 'reports.view');
  const w = window(input, businessZone(ctx));
  const jobsScope = scoped(ctx, input, 'branch_id');
  const col = column => scoped(ctx, input, column).sql;
  const p = { ...jobsScope.params, start: w.start, end: w.end };
  const where = `business_id = :business AND ${jobsScope.sql}`;

  const jobs = ctx.db.get(`SELECT count(*) AS created, sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      sum(CASE WHEN discount > 0 AND discount_status IN ('approved','pending') THEN discount ELSE 0 END) AS discounts
    FROM jobs WHERE ${where} AND created_at >= :start AND created_at < :end`, p);
  const paid = ctx.db.get(`SELECT count(*) AS n, COALESCE(sum(amount), 0) AS revenue, COALESCE(sum(tip_amount), 0) AS tips FROM payments WHERE ${where} AND created_at >= :start AND created_at < :end`, p);
  const refunds = ctx.db.get(`SELECT COALESCE(sum(r.amount), 0) AS total FROM refunds r JOIN jobs j ON j.id = r.job_id WHERE j.business_id = :business AND ${col('j.branch_id')} AND r.status = 'approved' AND r.created_at >= :start AND r.created_at < :end`, p);
  const commissions = ctx.db.get(`SELECT COALESCE(sum(amount), 0) AS total FROM worker_earnings WHERE ${where} AND kind IN ('commission','adjustment') AND earned_at >= :start AND earned_at < :end`, p);
  const expenses = ctx.db.get(`SELECT COALESCE(sum(amount), 0) AS total FROM expenses WHERE ${where} AND status = 'paid' AND paid_at >= :start AND paid_at < :end`, p);
  const quality = ctx.db.get(`SELECT count(*) AS reviewed, sum(CASE WHEN outcome = 'passed' THEN 1 ELSE 0 END) AS passed, sum(CASE WHEN outcome = 'rework' THEN 1 ELSE 0 END) AS rework
    FROM quality_checks q JOIN jobs j ON j.id = q.job_id WHERE j.business_id = :business AND ${col('j.branch_id')} AND q.created_at >= :start AND q.created_at < :end`, p);
  const cash = ctx.db.get(`SELECT COALESCE(sum(expected_cash), 0) AS expected, COALESCE(sum(difference), 0) AS difference FROM cash_sessions WHERE ${where} AND status <> 'open' AND closed_at >= :start AND closed_at < :end`, p);
  const workers = ctx.db.get(`SELECT count(*) AS total, sum(on_shift) AS on_shift FROM workers WHERE ${where} AND status = 'active'`, p);
  const byService = ctx.db.all(`SELECT j.service_name AS service, count(*) AS jobs, COALESCE(sum(p.amount), 0) AS revenue FROM payments p JOIN jobs j ON j.id = p.job_id
    WHERE p.business_id = :business AND ${col('p.branch_id')} AND p.created_at >= :start AND p.created_at < :end GROUP BY j.service_name ORDER BY revenue DESC`, p);
  const byStatus = ctx.db.all(`SELECT status, count(*) AS n FROM jobs WHERE ${where} AND created_at >= :start AND created_at < :end GROUP BY status`, p);

  const netRevenue = paid.revenue - refunds.total;
  const metrics = {
    jobsCreated: jobs.created, jobsPaid: paid.n, jobsCancelled: jobs.cancelled || 0,
    revenue: paid.revenue, refunds: refunds.total, netRevenue, tips: paid.tips, discounts: jobs.discounts || 0,
    commissions: commissions.total, expenses: expenses.total, estimatedProfit: netRevenue - commissions.total - expenses.total,
    averageTicket: paid.n ? Math.round(paid.revenue / paid.n) : 0,
    qualityReviewed: quality.reviewed, qualityPassed: quality.passed || 0, rework: quality.rework || 0,
    cashExpected: cash.expected, cashDifference: cash.difference
  };
  const score = branchScore({
    revenue: netRevenue, expenses: expenses.total, commissions: commissions.total, revenueTarget: settings(ctx).revenueTargetDaily * w.days,
    qualityReviewed: quality.reviewed, qualityPassed: quality.passed || 0, jobs: jobs.created, reworked: quality.rework || 0,
    cashExpected: cash.expected, cashDifference: cash.difference, workersTotal: workers.total, workersOnShift: workers.on_shift || 0
  });
  return { period: { from: w.from, to: w.to, days: w.days }, metrics, score, byService, byStatus: byStatus.map(r => ({ status: r.status, label: STATUS_LABELS[r.status], count: r.n })) };
}

/** Trial balance from the ledger, scoped to the actor's branches. */
export function trialBalance(ctx, input = {}) {
  requirePermission(ctx, 'reports.view');
  const s = scoped(ctx, input, 't.branch_id');
  const rows = ctx.db.all(`SELECT e.account, sum(e.debit) AS debits, sum(e.credit) AS credits FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
    WHERE t.business_id = :business AND ${s.sql} GROUP BY e.account ORDER BY e.account`, s.params);
  const accounts = rows.map(r => ({ account: r.account, label: ACCOUNTS[r.account]?.label || r.account, type: ACCOUNTS[r.account]?.type, debits: r.debits, credits: r.credits, balance: accountBalance(r.account, r.debits, r.credits) }));
  const totals = accounts.reduce((t, a) => ({ debits: t.debits + a.debits, credits: t.credits + a.credits }), { debits: 0, credits: 0 });
  return { accounts, totals, balanced: totals.debits === totals.credits };
}

const EXPORTS = ['jobs', 'payments', 'earnings', 'expenses', 'ledger', 'summary'];

function exportRows(ctx, kind, input) {
  const w = window(input, businessZone(ctx));
  if (kind === 'summary') {
    const s = summary(ctx, input);
    return [['Metric', 'Value'], ['Period', `${s.period.from} to ${s.period.to}`], ...Object.entries(s.metrics).map(([k, v]) => [k, v]), [], ['Branch score', s.score.score ?? 'Not enough data'], ['Classification', s.score.classification], ['Data completeness %', s.score.completeness],
      ...s.score.factors.map(f => [`Factor: ${f.name} (weight ${f.weight})`, f.score == null ? 'Not enough data' : Math.round(f.score * 10) / 10])];
  }
  const sc = scoped(ctx, input, 'x.branch_id');
  const p = { ...sc.params, start: w.start, end: w.end };
  if (kind === 'jobs') {
    const rows = ctx.db.all(`SELECT x.code, x.created_at, x.plate, x.vehicle_type, x.customer_name, x.service_name, x.original_price, x.discount, x.final_price, x.status, x.payment_status FROM jobs x WHERE x.business_id = :business AND ${sc.sql} AND x.created_at >= :start AND x.created_at < :end ORDER BY x.created_at`, p);
    return [['Job code', 'Created (UTC)', 'Plate', 'Vehicle', 'Customer', 'Service', 'Original price', 'Discount', 'Final price', 'Status', 'Payment'], ...rows.map(r => [r.code, r.created_at, r.plate, r.vehicle_type, r.customer_name, r.service_name, r.original_price, r.discount, r.final_price, STATUS_LABELS[r.status], r.payment_status])];
  }
  if (kind === 'payments') {
    const rows = ctx.db.all(`SELECT x.created_at, j.code, x.amount, x.tip_amount, x.tip_method, x.status, (SELECT group_concat(method || ':' || amount, ' + ') FROM payment_parts WHERE payment_id = x.id) AS parts FROM payments x JOIN jobs j ON j.id = x.job_id WHERE x.business_id = :business AND ${sc.sql} AND x.created_at >= :start AND x.created_at < :end ORDER BY x.created_at`, p);
    return [['Paid at (UTC)', 'Job code', 'Amount', 'Tip', 'Tip method', 'Status', 'Parts'], ...rows.map(r => [r.created_at, r.code, r.amount, r.tip_amount, r.tip_method || '', r.status, r.parts])];
  }
  if (kind === 'earnings') {
    requirePermission(ctx, 'earnings.view');
    const rows = ctx.db.all(`SELECT x.earned_at, w.name, x.kind, x.amount, x.note, CASE WHEN x.payout_id IS NULL THEN 'unpaid' ELSE 'paid' END AS state FROM worker_earnings x JOIN workers w ON w.id = x.worker_id WHERE x.business_id = :business AND ${sc.sql} AND x.earned_at >= :start AND x.earned_at < :end ORDER BY x.earned_at`, p);
    return [['Earned at (UTC)', 'Worker', 'Kind', 'Amount', 'Note', 'State'], ...rows.map(r => [r.earned_at, r.name, r.kind, r.amount, r.note, r.state])];
  }
  if (kind === 'expenses') {
    const rows = ctx.db.all(`SELECT x.created_at, x.category, x.description, x.amount, x.payment_source, x.status FROM expenses x WHERE x.business_id = :business AND ${sc.sql} AND x.created_at >= :start AND x.created_at < :end ORDER BY x.created_at`, p);
    return [['Created (UTC)', 'Category', 'Description', 'Amount', 'Source', 'Status'], ...rows.map(r => [r.created_at, CATEGORY_LABELS[r.category], r.description, r.amount, r.payment_source, r.status])];
  }
  const rows = ctx.db.all(`SELECT x.created_at, x.event_type, x.memo, e.account, e.debit, e.credit FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.transaction_id WHERE x.business_id = :business AND ${sc.sql} AND x.created_at >= :start AND x.created_at < :end ORDER BY x.created_at, e.id`, p);
  return [['Posted (UTC)', 'Event', 'Memo', 'Account', 'Debit', 'Credit'], ...rows.map(r => [r.created_at, r.event_type, r.memo || '', ACCOUNTS[r.account]?.label || r.account, r.debit, r.credit])];
}

export function exportReport(ctx, input = {}) {
  requirePermission(ctx, 'reports.view');
  const format = oneOf(input.format || 'xlsx', ['xlsx', 'csv'], 'Format');
  const kinds = input.kind === 'all' ? EXPORTS : [oneOf(input.kind || 'summary', EXPORTS, 'Report')];
  const w = window(input, businessZone(ctx));
  const filename = `shinepro-${kinds.length > 1 ? 'workbook' : kinds[0]}-${w.from}_${w.to}.${format}`;
  if (format === 'csv') {
    if (kinds.length > 1) throw invalid('CSV exports contain a single report; choose one.');
    return { filename, contentType: 'text/csv; charset=utf-8', body: Buffer.from(csv(exportRows(ctx, kinds[0], input)), 'utf8') };
  }
  const sheets = kinds.map(kind => ({ name: kind[0].toUpperCase() + kind.slice(1), rows: exportRows(ctx, kind, input), widths: [22, 18, 18, 16, 22, 22, 14, 12, 14, 16, 12] }));
  return { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: workbook(sheets) };
}

export function workerScores(ctx) {
  requirePermission(ctx, 'reports.view');
  return listEarnings(ctx).map(w => ({ workerId: w.workerId, name: w.name, score: w.score }));
}
