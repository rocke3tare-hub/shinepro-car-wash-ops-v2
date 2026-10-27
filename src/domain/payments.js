import { AppError, invalid } from '../lib/errors.js';
import { parseToman } from '../lib/money.js';
import { text } from '../lib/validate.js';

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'customer_credit'];
export const TIP_METHODS = ['cash', 'card', 'bank_transfer'];

/**
 * Validate and normalise a payment request against the job.
 * - Job must be ready for payment with no pending discount decision.
 * - Parts must equal the amount due exactly (tips are separate, never "overpayment").
 * - At most 4 parts, positive amounts, known methods, unique method per payment.
 */
export function preparePayment(job, input) {
  if (job.status !== 'ready_for_payment') {
    throw new AppError('JOB_NOT_READY_FOR_PAYMENT', 'Payment can only be taken after quality approval.', 422);
  }
  if (job.payment_status !== 'unpaid') throw new AppError('ALREADY_PAID', 'This job already has a confirmed payment.', 409);
  if (job.discount_status === 'pending') throw new AppError('DISCOUNT_PENDING', 'The discount on this job is waiting for approval.', 422);

  const rawParts = Array.isArray(input.parts) ? input.parts : [];
  if (rawParts.length === 0) throw invalid('Add at least one payment method.');
  if (rawParts.length > 4) throw invalid('A payment can be split across at most four methods.');
  const seen = new Set();
  const parts = rawParts.map((part, index) => {
    const method = String(part?.method || '');
    if (!PAYMENT_METHODS.includes(method)) throw invalid(`Payment method ${index + 1} is not supported.`);
    if (seen.has(method)) throw invalid('Use each payment method only once per payment.');
    seen.add(method);
    return {
      method,
      amount: parseToman(part.amount, `Payment amount ${index + 1}`, { allowZero: false }),
      reference: text(part.reference, 'Payment reference', { max: 80 })
    };
  });
  const paid = parts.reduce((sum, part) => sum + part.amount, 0);
  if (paid < job.final_price) throw new AppError('INSUFFICIENT_PAYMENT', `Payment parts total ${paid.toLocaleString('en-US')} toman but ${job.final_price.toLocaleString('en-US')} toman is due.`, 422);
  if (paid > job.final_price) throw new AppError('OVERPAYMENT_NOT_ALLOWED', 'Payment parts must equal the amount due. Record any extra as a tip.', 422);

  const tipAmount = parseToman(input.tipAmount ?? 0, 'Tip');
  let tipMethod = null;
  if (tipAmount > 0) {
    tipMethod = String(input.tipMethod || 'cash');
    if (!TIP_METHODS.includes(tipMethod)) throw invalid('Tips can be received in cash, by card or by bank transfer.');
  }
  return { parts, amount: paid, tipAmount, tipMethod };
}

/** Split a tip across workers as evenly as possible; remainder goes to the first. */
export function splitTip(tipAmount, workerIds) {
  if (!workerIds.length || tipAmount <= 0) return [];
  const share = Math.floor(tipAmount / workerIds.length);
  const remainder = tipAmount - share * workerIds.length;
  return workerIds.map((workerId, index) => ({ workerId, amount: share + (index === 0 ? remainder : 0) })).filter(row => row.amount > 0);
}

/** Stable hash input so a retried request with a different body is detected. */
export function canonicalPaymentRequest(jobId, prepared) {
  return JSON.stringify({ jobId, parts: prepared.parts.map(p => [p.method, p.amount]).sort(), tip: prepared.tipAmount, tipMethod: prepared.tipMethod });
}
