import { applyBasisPoints, BASIS_POINTS, isToman } from '../lib/money.js';
import { AppError, invalid } from '../lib/errors.js';

export const VEHICLE_TYPES = ['small', 'sedan', 'suv', 'van'];
export const VEHICLE_LABELS = { small: 'Small', sedan: 'Sedan', suv: 'SUV', van: 'Van' };

/**
 * Price a job. A service that is not offered for the vehicle type is rejected
 * outright (the original fell back to 0 and allowed negative totals).
 *
 * @param {{ amount: number }|undefined} price   price row in force for this vehicle type
 * @param {number} discount                     requested discount in toman
 * @param {number} approvalThresholdBp          discounts above this share need approval
 */
export function quote(price, discount, approvalThresholdBp) {
  if (!price) throw new AppError('SERVICE_NOT_OFFERED', 'This service is not offered for the selected vehicle type.', 422);
  if (!isToman(price.amount) || price.amount <= 0) throw new Error('Corrupt price row');
  if (!isToman(discount)) throw invalid('Discount must be a whole, non-negative toman amount.');
  if (discount > price.amount) throw invalid('Discount cannot exceed the service price.', { field: 'discount' });
  const limit = applyBasisPoints(price.amount, approvalThresholdBp);
  return {
    originalPrice: price.amount,
    discount,
    finalPrice: price.amount - discount,
    discountNeedsApproval: discount > limit,
    discountApprovalLimit: limit
  };
}

/**
 * Commission for one assignment against a base (the job's final price).
 * Half-up rounding to the toman, integer arithmetic only.
 */
export function commissionFor(base, assignment) {
  if (assignment.commission_type === 'fixed') return assignment.fixed_amount;
  return applyBasisPoints(base, assignment.basis_points);
}

/**
 * Validate a set of percentage assignments against the rule-set pool limit.
 * Fixed amounts are converted to their basis-point equivalent of the base so
 * they count toward the limit too (the original ignored them).
 */
export function assertPoolLimit(base, assignments, poolLimitBp) {
  const total = assignments.reduce((sum, a) => sum + commissionFor(base, a), 0);
  const limit = applyBasisPoints(base, poolLimitBp);
  if (total > limit) {
    throw new AppError('COMMISSION_LIMIT_EXCEEDED', `Worker commissions (${total.toLocaleString('en-US')} toman) exceed the ${(poolLimitBp / 100).toFixed(2)}% pool limit for this service.`, 422);
  }
  return { total, limit };
}

export function commissionBreakdown(base, assignments) {
  const rows = assignments.map(a => ({ ...a, amount: commissionFor(base, a) }));
  return { base, rows, total: rows.reduce((sum, row) => sum + row.amount, 0) };
}

/** Loyalty: whole points per full block of spend (e.g. 1 point per 10,000 toman). */
export function loyaltyPoints(amount, tomanPerPoint) {
  if (!tomanPerPoint || tomanPerPoint <= 0) return 0;
  return Math.floor(amount / tomanPerPoint);
}

export { BASIS_POINTS };
