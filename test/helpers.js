import http from 'node:http';
import { Database } from '../src/db/database.js';
import { buildConfig } from '../src/config.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/http/server.js';

export const PASSWORD = 'Test-password-123';

/** Boot the real HTTP stack on an ephemeral port with a fresh in-memory database. */
export async function startTestServer() {
  const config = buildConfig({ APP_ENV: 'test', PASSWORD_PEPPER: 'test-pepper', PORT: '0' });
  const db = new Database(':memory:');
  db.migrate();
  const seeded = seed(db, config, { ownerEmail: 'owner@shinepro.local', ownerPassword: PASSWORD, demo: true, demoPassword: PASSWORD });
  const quietLog = { error: () => {} };
  const server = http.createServer(createApp({ db, config, log: quietLog }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, config, base, seeded,
    close: () => new Promise(resolve => { server.close(() => { db.close(); resolve(); }); })
  };
}

/** A tiny client that keeps its own session cookie, like one browser profile. */
export function client(base) {
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: payload, headers: response.headers };
  }
  return {
    get: (path, headers) => call('GET', path, undefined, headers),
    post: (path, body = {}, headers) => call('POST', path, body, headers),
    put: (path, body = {}, headers) => call('PUT', path, body, headers),
    patch: (path, body = {}, headers) => call('PATCH', path, body, headers),
    del: (path, headers) => call('DELETE', path, undefined, headers),
    raw: call,
    async login(email, password = PASSWORD) {
      const result = await call('POST', '/api/auth/login', { email, password });
      if (result.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(result.body)}`);
      return result;
    }
  };
}

export async function signedIn(base, email) {
  const c = client(base);
  await c.login(email);
  return c;
}
