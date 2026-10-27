import { invalid } from './errors.js';

/** Trimmed string with length bounds. Returns null for blank optional values. */
export function text(value, field, { required = false, max = 200, min = 0 } = {}) {
  const result = value == null ? '' : String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!result) {
    if (required) throw invalid(`${field} is required.`, { field });
    return null;
  }
  if (result.length < min) throw invalid(`${field} must be at least ${min} characters.`, { field });
  if (result.length > max) throw invalid(`${field} must be at most ${max} characters.`, { field });
  return result;
}

export function oneOf(value, allowed, field, { required = true, fallback = undefined } = {}) {
  if ((value == null || value === '') && !required) return fallback ?? null;
  if (!allowed.includes(value)) throw invalid(`${field} must be one of: ${allowed.join(', ')}.`, { field });
  return value;
}

export function email(value, field = 'Email', { required = true } = {}) {
  const result = text(value, field, { required, max: 254 });
  if (result == null) return null;
  const lowered = result.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lowered)) throw invalid(`${field} is not a valid address.`, { field });
  return lowered;
}

export function phone(value, field = 'Phone', { required = false } = {}) {
  const result = text(value, field, { required, max: 32 });
  if (result == null) return null;
  // Accept Latin and Persian/Arabic-Indic digits, spaces, +, -, parentheses.
  if (!/^[+()\-\s0-9۰-۹٠-٩]{5,32}$/.test(result)) throw invalid(`${field} contains invalid characters.`, { field });
  return result;
}

export function id(value, field = 'id', { required = true } = {}) {
  if ((value == null || value === '') && !required) return null;
  const result = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw invalid(`${field} is not a valid identifier.`, { field });
  return result.toLowerCase();
}

export function int(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  if ((value == null || value === '') && !required) return null;
  const textValue = String(value ?? '').trim();
  if (!/^-?\d{1,15}$/.test(textValue)) throw invalid(`${field} must be a whole number.`, { field });
  const number = Number(textValue);
  if (number < min || number > max) throw invalid(`${field} must be between ${min} and ${max}.`, { field });
  return number;
}

export function bool(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

export function isoDate(value, field, { required = true } = {}) {
  if ((value == null || value === '') && !required) return null;
  const textValue = String(value ?? '');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(textValue) ? new Date(`${textValue}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== textValue) {
    throw invalid(`${field} must be a real date in YYYY-MM-DD format.`, { field });
  }
  return textValue;
}
