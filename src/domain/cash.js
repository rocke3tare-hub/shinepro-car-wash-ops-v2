// Cash register maths. Expected cash is always derived from the opening float
// plus signed movements; it is never accepted from a client.

export const MOVEMENT_LABELS = {
  payment: 'Customer payment',
  tip: 'Tip received',
  refund: 'Refund paid',
  expense: 'Expense paid',
  payout: 'Worker payout',
  added: 'Cash added',
  removed: 'Cash removed / deposited'
};

/** Movements that take money out of the drawer are stored negative. */
export const OUTFLOW_KINDS = new Set(['refund', 'expense', 'payout', 'removed']);

export function signedAmount(kind, amount) {
  return OUTFLOW_KINDS.has(kind) ? -Math.abs(amount) : Math.abs(amount);
}

export function expectedCash(openingCash, movements) {
  return movements.reduce((total, movement) => total + movement.amount, openingCash);
}

export function summarize(openingCash, movements) {
  const byKind = Object.fromEntries(Object.keys(MOVEMENT_LABELS).map(kind => [kind, 0]));
  for (const movement of movements) byKind[movement.kind] += Math.abs(movement.amount);
  return { openingCash, byKind, expected: expectedCash(openingCash, movements) };
}

/** Whether a closing difference needs a second person's review. */
export function needsReview(difference, thresholdToman) {
  return Math.abs(difference) > thresholdToman;
}
