import { AppError } from '../lib/errors.js';

// Chart of accounts. Assets/expenses carry debit balances; liabilities,
// revenue and equity carry credit balances.
export const ACCOUNTS = {
  cash_on_hand: { label: 'Cash on hand', type: 'asset' },
  card_clearing: { label: 'Card clearing', type: 'asset' },
  bank: { label: 'Bank', type: 'asset' },
  customer_receivable: { label: 'Customer credit receivable', type: 'asset' },
  service_revenue: { label: 'Service revenue', type: 'revenue' },
  sales_returns: { label: 'Refunds (contra revenue)', type: 'contra_revenue' },
  tips_payable: { label: 'Tips payable to workers', type: 'liability' },
  commissions_payable: { label: 'Commissions payable', type: 'liability' },
  commission_expense: { label: 'Commission expense', type: 'expense' },
  owner_funding: { label: 'Owner funding', type: 'equity' },
  cash_over_short: { label: 'Cash over / short', type: 'expense' },
  'expense:direct_job': { label: 'Direct job expenses', type: 'expense' },
  'expense:daily_branch': { label: 'Daily branch expenses', type: 'expense' },
  'expense:monthly_operating': { label: 'Monthly operating expenses', type: 'expense' },
  'expense:inventory_purchase': { label: 'Inventory purchases', type: 'expense' },
  'expense:maintenance': { label: 'Maintenance', type: 'expense' },
  'expense:other': { label: 'Other expenses', type: 'expense' }
};

export const METHOD_ACCOUNT = {
  cash: 'cash_on_hand',
  card: 'card_clearing',
  bank_transfer: 'bank',
  customer_credit: 'customer_receivable'
};

export const debit = (account, amount) => ({ account, debit: amount, credit: 0 });
export const credit = (account, amount) => ({ account, debit: 0, credit: amount });

/** Drop zero lines, merge duplicates per side, and prove debits = credits. */
export function balanced(entries) {
  const merged = new Map();
  for (const entry of entries) {
    if (!ACCOUNTS[entry.account]) throw new Error(`Unknown ledger account: ${entry.account}`);
    if (!Number.isSafeInteger(entry.debit) || !Number.isSafeInteger(entry.credit) || entry.debit < 0 || entry.credit < 0) throw new Error('Ledger amounts must be non-negative integers');
    if (entry.debit === 0 && entry.credit === 0) continue;
    const key = `${entry.account}|${entry.debit > 0 ? 'D' : 'C'}`;
    const current = merged.get(key) || { account: entry.account, debit: 0, credit: 0 };
    current.debit += entry.debit;
    current.credit += entry.credit;
    merged.set(key, current);
  }
  const lines = [...merged.values()];
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) {
    throw new AppError('LEDGER_UNBALANCED', 'The financial transaction is unbalanced and was not posted.', 500, { totalDebit, totalCredit });
  }
  if (lines.length === 0) throw new AppError('LEDGER_EMPTY', 'A financial transaction must contain at least one amount.', 500);
  return lines;
}

/** Customer payment: per-part debits, revenue credit, tip as a liability. */
export function paymentEntries({ parts, finalPrice, tipAmount, tipMethod }) {
  const entries = parts.map(part => debit(METHOD_ACCOUNT[part.method], part.amount));
  entries.push(credit('service_revenue', finalPrice));
  if (tipAmount > 0) {
    entries.push(debit(METHOD_ACCOUNT[tipMethod], tipAmount));
    entries.push(credit('tips_payable', tipAmount));
  }
  return balanced(entries);
}

export function commissionEarnedEntries(total) {
  return total > 0 ? balanced([debit('commission_expense', total), credit('commissions_payable', total)]) : [];
}

export function refundEntries({ amount, method, commissionReversal }) {
  const entries = [debit('sales_returns', amount), credit(METHOD_ACCOUNT[method], amount)];
  if (commissionReversal > 0) entries.push(debit('commissions_payable', commissionReversal), credit('commission_expense', commissionReversal));
  return balanced(entries);
}

export function expensePaidEntries({ category, amount, source }) {
  return balanced([debit(`expense:${category}`, amount), credit(METHOD_ACCOUNT[source], amount)]);
}

/**
 * Worker payout. commission may be negative (refund reversals not yet
 * recovered); it is then netted against tips so both liabilities clear.
 */
export function payoutEntries({ commission, tips, method }) {
  const total = commission + tips;
  if (total <= 0) throw new AppError('NOTHING_TO_PAY', 'Payout total must be positive.', 422);
  const entries = [debit('tips_payable', tips), credit(METHOD_ACCOUNT[method], total)];
  entries.push(commission >= 0 ? debit('commissions_payable', commission) : credit('commissions_payable', -commission));
  return balanced(entries);
}

export function cashAddedEntries(amount) { return balanced([debit('cash_on_hand', amount), credit('owner_funding', amount)]); }
export function cashRemovedEntries(amount) { return balanced([debit('bank', amount), credit('cash_on_hand', amount)]); }

/** Positive difference = cash over, negative = short. */
export function cashDifferenceEntries(difference) {
  if (difference === 0) return [];
  return difference > 0
    ? balanced([debit('cash_on_hand', difference), credit('cash_over_short', difference)])
    : balanced([debit('cash_over_short', -difference), credit('cash_on_hand', -difference)]);
}

/** Signed balance for an account type from summed debits/credits. */
export function accountBalance(account, debits, credits) {
  const type = ACCOUNTS[account]?.type;
  return ['asset', 'expense', 'contra_revenue'].includes(type) ? debits - credits : credits - debits;
}
