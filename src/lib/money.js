// Money is always an integer number of toman. Rates are integer basis points
// (10000 = 100%). No floating-point value is ever stored or compared as money.
import { AppError } from './errors.js';

export const BASIS_POINTS = 10_000;

/** True when value is a safe, non-negative integer. */
export function isToman(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse untrusted input (number or digit string) into integer toman.
 * Rejects decimals, negatives, exponents, blanks and unsafe magnitudes.
 */
export function parseToman(value, field = 'Amount', { allowZero = true } = {}) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(text)) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a whole, non-negative toman amount.`, 422, { field });
  }
  const amount = Number(text);
  if (!allowZero && amount === 0) {
    throw new AppError('VALIDATION_ERROR', `${field} must be greater than zero.`, 422, { field });
  }
  return amount;
}

/** Parse a basis-point rate (0..10000). */
export function parseBasisPoints(value, field = 'Rate') {
  const text = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) > BASIS_POINTS) {
    throw new AppError('VALIDATION_ERROR', `${field} must be between 0 and 10000 basis points.`, 422, { field });
  }
  return Number(text);
}

/**
 * amount * basisPoints / 10000, rounded half-up to the nearest toman.
 * Uses BigInt internally so intermediate products cannot lose precision.
 */
export function applyBasisPoints(amount, basisPoints) {
  if (!isToman(amount)) throw new TypeError('amount must be integer toman');
  if (!Number.isInteger(basisPoints) || basisPoints < 0) throw new TypeError('basisPoints must be a non-negative integer');
  const result = (BigInt(amount) * BigInt(basisPoints) + 5000n) / 10000n;
  return Number(result);
}

export function sum(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new TypeError('sum expects integer toman values');
    total += value;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('Money total exceeds the safe integer range');
  return total;
}

/** Display helper shared by server-rendered text (receipts, CSV headers). */
export function formatToman(value) {
  return `${Number(value || 0).toLocaleString('en-US')} toman`;
}
