import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env reader (KEY=VALUE, # comments, optional quotes). Real
 * environment variables always win over the file, so deployments can inject
 * secrets without touching disk.
 */
export function loadEnvFile(file = path.join(ROOT, '.env'), target = process.env) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (target[key] === undefined) target[key] = value;
  }
}

const DEV_PEPPER = 'development-only-pepper-change-me';

export function buildConfig(env = process.env) {
  const number = (key, fallback) => {
    const value = env[key];
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number.`);
    return parsed;
  };
  const config = Object.freeze({
    env: env.APP_ENV || 'development',
    label: env.APP_LABEL || 'SHINEPRO STAGING',
    host: env.HOST || '127.0.0.1',
    port: number('PORT', 8787),
    databaseFile: env.DATABASE_FILE || path.join(ROOT, 'data', 'shinepro.sqlite'),
    sessionTtlSeconds: number('SESSION_TTL_SECONDS', 8 * 3600),
    maxBodyBytes: number('MAX_BODY_BYTES', 256 * 1024),
    passwordPepper: env.PASSWORD_PEPPER || DEV_PEPPER,
    publicOrigin: env.PUBLIC_ORIGIN || `http://localhost:${number('PORT', 8787)}`,
    secureCookies: env.SECURE_COOKIES === 'true',
    paymentsMode: env.PAYMENTS_MODE || 'test',
    trustProxy: env.TRUST_PROXY === 'true',
    publicBusinessId: env.PUBLIC_BUSINESS_ID || null
  });
  return config;
}

/** Refuse to boot a production instance with development defaults. */
export function assertSafeConfig(config) {
  if (config.env !== 'production') return;
  const problems = [];
  if (config.passwordPepper === DEV_PEPPER || config.passwordPepper.length < 32) problems.push('PASSWORD_PEPPER must be a random secret of at least 32 characters');
  if (!config.secureCookies) problems.push('SECURE_COOKIES must be true (serve over HTTPS)');
  if (config.paymentsMode === 'test') problems.push('PAYMENTS_MODE must not be "test"');
  if (!config.publicOrigin.startsWith('https://')) problems.push('PUBLIC_ORIGIN must be an https:// URL');
  if (problems.length) throw new Error(`Unsafe production configuration:\n- ${problems.join('\n- ')}`);
}
