import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../lib/errors.js';

export const SESSION_COOKIE = 'sp_session';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
};

export const PAGE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}

export function sessionCookie(token, config, maxAge = config.sessionTtlSeconds) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}

/** Read the full body as bytes first, then decode: multi-byte UTF-8 survives chunk boundaries. */
export async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AppError('REQUEST_TOO_LARGE', 'The request body is too large.', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new AppError('INVALID_JSON', 'The request body must be a JSON object.', 400);
  }
}

export function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': API_CSP, ...headers });
  response.end(body);
}

export function sendFile(response, { filename, contentType, body }) {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  response.writeHead(200, {
    'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${safeName}"`, 'Content-Security-Policy': API_CSP
  });
  response.end(body);
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8'
};

const PAGE_ALIASES = { '/': '/landing.html', '/app': '/app.html', '/portal': '/customer.html', '/register-business': '/business.html' };

/** Serve files from publicDir only: no traversal, no dotfiles, allow-listed types. */
export function serveStatic(publicDir, pathname, response, method) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  const requested = PAGE_ALIASES[decoded] || decoded;
  if (requested.includes('\0') || requested.split('/').some(segment => segment.startsWith('.'))) return false;
  const root = path.resolve(publicDir);
  const file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(root + path.sep)) return false;
  const type = STATIC_TYPES[path.extname(file).toLowerCase()];
  if (!type) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const headers = { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300' };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGE_CSP;
  response.writeHead(200, headers);
  if (method === 'HEAD') response.end();
  else fs.createReadStream(file).on('error', () => response.destroy()).pipe(response);
  return true;
}

/** Fixed-window in-memory limiter for anonymous public endpoints. */
export class RateLimiter {
  constructor({ limit, windowMs }) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  check(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) { this.hits.set(key, { start: now, count: 1 }); this.sweep(now); return; }
    entry.count += 1;
    if (entry.count > this.limit) throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a few minutes and try again.', 429);
  }
  sweep(now) {
    if (this.hits.size < 5000) return;
    for (const [key, entry] of this.hits) if (now - entry.start >= this.windowMs) this.hits.delete(key);
  }
}

export function clientIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress || 'unknown';
}
