import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, buildConfig, assertSafeConfig, loadEnvFile } from '../config.js';
import { Database } from '../db/database.js';
import { AppError, toErrorResponse } from '../lib/errors.js';
import { actorFromToken } from '../services/auth.js';
import { matchRoute } from './routes.js';
import { SECURITY_HEADERS, SESSION_COOKIE, RateLimiter, clientIp, parseCookies, readJson, sendFile, sendJson, serveStatic, sessionCookie } from './http.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Build the request handler. Exported separately from listen() so the
 * integration tests can drive the real stack against an in-memory database.
 */
export function createApp({ db, config, publicDir = path.join(ROOT, 'public'), log = console }) {
  const limiters = {
    signup: new RateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 }),
    registration: new RateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 })
  };
  const allowedOrigin = new URL(config.publicOrigin).origin;

  return async function handle(request, response) {
    const requestId = crypto.randomUUID();
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(key, value);
    if (config.secureCookies) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    response.setHeader('X-Request-Id', requestId);

    let url;
    try { url = new URL(request.url || '/', 'http://localhost'); } catch { return sendJson(response, 400, { error: 'BAD_REQUEST', message: 'Malformed URL.' }); }
    const { pathname } = url;

    try {
      if (!pathname.startsWith('/api/')) {
        if ((request.method === 'GET' || request.method === 'HEAD') && serveStatic(publicDir, pathname, response, request.method)) return;
        return sendJson(response, 404, { error: 'NOT_FOUND', message: 'Page not found.' });
      }

      const { route, params, pathMatched } = matchRoute(request.method, pathname);
      if (!route) {
        return pathMatched
          ? sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED', message: 'This method is not supported here.' })
          : sendJson(response, 404, { error: 'NOT_FOUND', message: 'Unknown API endpoint.' });
      }

      let body = {};
      if (MUTATING.has(request.method)) {
        // CSRF defence: JSON-only bodies (cannot be sent cross-site without a
        // CORS preflight we never grant) plus an Origin check when present.
        const origin = request.headers.origin;
        if (origin && origin !== allowedOrigin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
          throw new AppError('CROSS_ORIGIN_DENIED', 'Cross-origin requests are not allowed.', 403);
        }
        const type = String(request.headers['content-type'] || '');
        const length = Number(request.headers['content-length'] || 0);
        if ((length > 0 || request.headers['transfer-encoding']) && !type.toLowerCase().startsWith('application/json')) {
          throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.', 415);
        }
        body = await readJson(request, config.maxBodyBytes);
      }

      const ip = clientIp(request, config.trustProxy);
      if (route.limiter) limiters[route.limiter].check(ip);
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE] || null;
      const actor = route.needsAuth ? actorFromToken(db, token) : null;
      if (route.needsAuth && !actor) throw new AppError('AUTHENTICATION_REQUIRED', 'Sign in is required.', 401);

      const ctx = { db, config, actor, requestId };
      const input = { ctx, db, config, body, params, query: url.searchParams, request, token, ip };
      const result = route.tx ? db.tx(() => route.handler(input)) : route.handler(input);

      if (result.file) return sendFile(response, result.file);
      const headers = {};
      if (result.cookie !== undefined) headers['Set-Cookie'] = result.cookie ? sessionCookie(result.cookie, config) : sessionCookie('', config, 0);
      return sendJson(response, result.status || 200, { data: result.data, requestId }, headers);
    } catch (error) {
      const { status, body } = toErrorResponse(error, err => log.error(`[${requestId}]`, err));
      if (response.headersSent) return response.destroy();
      return sendJson(response, status, { ...body, requestId }, status === 401 ? { 'Set-Cookie': sessionCookie('', config, 0) } : {});
    }
  };
}

export function start() {
  loadEnvFile();
  const config = buildConfig();
  assertSafeConfig(config);
  const db = new Database(config.databaseFile);
  db.migrate(message => console.log(message));
  const server = http.createServer(createApp({ db, config }));
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.listen(config.port, config.host, () => {
    console.log(`${config.label} running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/`);
    console.log(`Database: ${config.databaseFile}`);
  });
  const shutdown = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) start();
