import crypto from 'node:crypto';
import { AppError } from '../lib/errors.js';
import { buildScope } from '../domain/permissions.js';
import { newId } from '../db/database.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password, pepper) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(`${password}${pepper}`, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return `scrypt$${SCRYPT.N}$${salt}$${digest}`;
}

export function verifyPassword(password, stored, pepper) {
  const [scheme, n, salt, digest] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !digest || !/^[0-9a-f]+$/.test(digest)) return false;
  const expected = Buffer.from(digest, 'hex');
  const candidate = crypto.scryptSync(`${password}${pepper}`, salt, expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('WEAK_PASSWORD', `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`, 422);
  }
  if (password.length > 200) throw new AppError('WEAK_PASSWORD', 'Passwords must be at most 200 characters.', 422);
}

// Verifying against a dummy hash keeps response time similar for unknown emails.
let dummyHash = null;
function dummy(pepper) {
  dummyHash ??= hashPassword(crypto.randomBytes(12).toString('hex'), pepper);
  return dummyHash;
}

const LOCK_WINDOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')";

export function login(db, config, { email, password, ip }) {
  const normalized = String(email || '').trim().toLowerCase();
  const ipHash = sha256(`${config.passwordPepper}:${ip || 'unknown'}`);
  const failures = db.get(`SELECT
      (SELECT count(*) FROM login_attempts WHERE email = :email AND succeeded = 0 AND created_at > ${LOCK_WINDOW}) AS by_email,
      (SELECT count(*) FROM login_attempts WHERE ip_hash = :ip AND succeeded = 0 AND created_at > ${LOCK_WINDOW}) AS by_ip`, { email: normalized, ip: ipHash });
  if (failures.by_email >= 8 || failures.by_ip >= 30) {
    throw new AppError('LOGIN_RATE_LIMITED', 'Too many failed sign-in attempts. Wait 15 minutes and try again.', 429);
  }
  const user = normalized ? db.get('SELECT * FROM users WHERE email = :email', { email: normalized }) : null;
  const valid = verifyPassword(String(password || ''), user?.password_hash ?? dummy(config.passwordPepper), config.passwordPepper) && user?.status === 'active';
  db.run('INSERT INTO login_attempts(email, ip_hash, succeeded) VALUES (:email, :ip, :ok)', { email: normalized, ip: ipHash, ok: valid ? 1 : 0 });
  if (!valid) throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
  const token = createSession(db, config, user.id);
  db.run(`UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: user.id });
  return { token, userId: user.id };
}

export function createSession(db, config, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
  db.run('INSERT INTO sessions(id, user_id, token_hash, expires_at) VALUES (:id, :user, :hash, :expires)', { id: newId(), user: userId, hash: sha256(token), expires: expiresAt });
  return token;
}

export function revokeSession(db, token) {
  if (!token) return;
  db.run(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = :hash AND revoked_at IS NULL`, { hash: sha256(token) });
}

export function revokeAllSessions(db, userId) {
  db.run(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = :user AND revoked_at IS NULL`, { user: userId });
}

/** Resolve a session token into an authorization context, or null. */
export function actorFromToken(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const row = db.get(`SELECT u.id, u.email, u.display_name, u.customer_id, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = :hash AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`, { hash: sha256(token) });
  if (!row || row.status !== 'active') return null;
  return actorForUser(db, row);
}

export function actorForUser(db, user) {
  const memberships = db.all(`SELECT m.business_id, m.role, m.branch_id FROM memberships m
    JOIN businesses b ON b.id = m.business_id
    WHERE m.user_id = :user AND m.status = 'active' AND b.status = 'active'
    ORDER BY b.created_at, m.created_at`, { user: user.id });
  if (!memberships.length) return null;
  // One active business per session; the first membership's business wins.
  const businessId = memberships[0].business_id;
  const scope = buildScope(memberships.filter(m => m.business_id === businessId));
  const worker = db.get('SELECT id FROM workers WHERE user_id = :user AND business_id = :business', { user: user.id, business: businessId });
  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    customerId: user.customer_id || null,
    workerId: worker?.id || null,
    businessId,
    ...scope
  };
}
