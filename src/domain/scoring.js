// Transparent 0-100 scorecards. A factor with no data is reported as such and
// excluded from the weighting rather than given an invented value.

export const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));

export function classify(score) {
  if (score == null) return 'Not enough data';
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Acceptable';
  if (score >= 40) return 'Needs attention';
  if (score >= 20) return 'Weak';
  return 'Critical';
}

/** factors: [{ name, weight, score|null, explanation }] */
export function weighted(factors) {
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const available = factors.filter(f => f.score != null && Number.isFinite(f.score));
  const availableWeight = available.reduce((s, f) => s + f.weight, 0);
  // Below half of the weight there is too little evidence to call it a score.
  const enough = totalWeight > 0 && availableWeight * 2 >= totalWeight;
  const score = enough && availableWeight ? available.reduce((s, f) => s + f.score * f.weight, 0) / availableWeight : null;
  return {
    score: score == null ? null : Math.round(score * 10) / 10,
    classification: classify(score),
    completeness: totalWeight ? Math.round((availableWeight / totalWeight) * 100) : 0,
    factors
  };
}

/**
 * Branch health from period metrics.
 * m: { revenue, expenses, commissions, revenueTarget, qualityReviewed, qualityPassed,
 *      jobs, reworked, cashExpected, cashDifference, workersTotal, workersOnShift }
 */
export function branchScore(m) {
  const profit = m.revenue - m.commissions - m.expenses;
  return weighted([
    { name: 'Revenue vs target', weight: 25, score: m.revenueTarget > 0 && m.revenue > 0 ? clamp((m.revenue / m.revenueTarget) * 100) : null, explanation: `Service revenue compared with the ${m.revenueTarget.toLocaleString('en-US')} toman target for the period.` },
    { name: 'Operating margin', weight: 20, score: m.revenue > 0 ? clamp(((profit / m.revenue) / 0.35) * 100) : null, explanation: 'Revenue minus commissions and expenses, compared with a 35% target margin.' },
    { name: 'Quality pass rate', weight: 20, score: m.qualityReviewed > 0 ? clamp((m.qualityPassed / m.qualityReviewed) * 100) : null, explanation: 'First-time passes divided by quality reviews.' },
    { name: 'Cash accuracy', weight: 15, score: m.cashExpected > 0 ? clamp(100 - (Math.abs(m.cashDifference) / m.cashExpected) * 100) : null, explanation: '100 minus the closing difference as a share of expected cash.' },
    { name: 'Rework control', weight: 10, score: m.jobs > 0 ? clamp(100 - (m.reworked / m.jobs) * 100) : null, explanation: 'Share of jobs that never needed rework.' },
    { name: 'Staff on shift', weight: 10, score: m.workersTotal > 0 ? clamp((m.workersOnShift / m.workersTotal) * 100) : null, explanation: 'Active workers currently marked on shift.' }
  ]);
}

/** Worker score from their own records only. */
export function workerScore(w) {
  return weighted([
    { name: 'Quality first-pass rate', weight: 50, score: w.reviewed > 0 ? clamp((w.passed / w.reviewed) * 100) : null, explanation: 'Jobs that passed quality without rework.' },
    { name: 'Completion reliability', weight: 30, score: w.assigned > 0 ? clamp((w.completed / w.assigned) * 100) : null, explanation: 'Assigned jobs that reached payment.' },
    // The original always scored attendance 100 regardless of presence.
    { name: 'On shift', weight: 20, score: w.onShift == null ? null : (w.onShift ? 100 : 0), explanation: 'Whether the worker is currently on shift.' }
  ]);
}
