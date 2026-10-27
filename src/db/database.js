import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Thin adapter over node:sqlite. This is the only module that knows which SQL
 * engine is in use; swapping to PostgreSQL means re-implementing this class.
 *
 * node:sqlite is synchronous, so a transaction run inside one request cannot
 * interleave with another request in the same process: every service call
 * wrapped in tx() is atomic and isolated.
 */
export class Database {
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.statements = new Map();
    this.depth = 0;
  }

  prepare(sql) {
    let entry = this.statements.get(sql);
    if (!entry) {
      // node:sqlite rejects unused named parameters, so remember which names
      // each statement uses and pass only those (callers can share a params bag).
      const names = [...new Set([...sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))];
      entry = { statement: this.raw.prepare(sql), names };
      this.statements.set(sql, entry);
    }
    return entry;
  }

  bind(entry, params) {
    const bound = {};
    for (const name of entry.names) {
      if (!(name in params)) throw new Error(`Missing SQL parameter :${name}`);
      const value = params[name];
      bound[name] = value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }
    return bound;
  }

  get(sql, params = {}) { const e = this.prepare(sql); return normalizeRow(e.statement.get(this.bind(e, params))); }
  all(sql, params = {}) { const e = this.prepare(sql); return e.statement.all(this.bind(e, params)).map(normalizeRow); }
  run(sql, params = {}) { const e = this.prepare(sql); return e.statement.run(this.bind(e, params)); }
  exec(sql) { this.raw.exec(sql); }

  /** Run fn atomically. Nested calls become savepoints. */
  tx(fn) {
    const savepoint = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = fn(this);
      if (result && typeof result.then === 'function') throw new Error('Database.tx callbacks must be synchronous.');
      this.depth -= 1;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth -= 1;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  migrate(log = () => {}) {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    const applied = [];
    for (const file of files) {
      const version = file.slice(0, 3);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const existing = this.get('SELECT checksum FROM schema_migrations WHERE version = :version', { version });
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      this.tx(() => {
        this.raw.exec(sql);
        this.run('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (:version, :checksum, :at)', { version, checksum, at: new Date().toISOString() });
      });
      applied.push(file);
      log(`Applied ${file}`);
    }
    return applied;
  }

  close() { this.raw.close(); }
}

// node:sqlite returns null-prototype objects; give callers plain objects.
function normalizeRow(row) {
  return row ? { ...row } : row;
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
