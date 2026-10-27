import crypto from 'node:crypto';
import { buildConfig, loadEnvFile } from '../config.js';
import { Database } from '../db/database.js';
import { seed } from '../db/seed.js';
import { MIN_PASSWORD_LENGTH } from '../services/auth.js';

// Usage: npm run db:seed            -> business, branch, catalog, owner
//        npm run db:seed -- --demo  -> also demo staff, workers, customers, stock
loadEnvFile();
const config = buildConfig();
const demo = process.argv.includes('--demo');
if (demo && config.env === 'production') {
  console.error('Refusing to load demo data into a production database.');
  process.exit(1);
}
const ownerEmail = process.env.SEED_OWNER_EMAIL || 'owner@shinepro.local';
const generated = !process.env.SEED_OWNER_PASSWORD;
const ownerPassword = process.env.SEED_OWNER_PASSWORD || crypto.randomBytes(12).toString('base64url');
if (ownerPassword.length < MIN_PASSWORD_LENGTH) {
  console.error(`SEED_OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}
const demoPassword = process.env.SEED_DEMO_PASSWORD || crypto.randomBytes(12).toString('base64url');

const db = new Database(config.databaseFile);
db.migrate();
const result = seed(db, config, { ownerEmail, ownerPassword, demo, demoPassword });
db.close();

console.log(`Business ready (${result.businessId}).`);
if (result.createdUsers.includes(ownerEmail.toLowerCase())) {
  console.log(`Owner account: ${ownerEmail}`);
  if (generated) console.log(`Owner password (shown once, change it after signing in): ${ownerPassword}`);
} else {
  console.log(`Owner ${ownerEmail} already existed; password unchanged.`);
}
if (demo) {
  const demoUsers = result.createdUsers.filter(email => email !== ownerEmail.toLowerCase());
  if (demoUsers.length) console.log(`Demo staff created: ${demoUsers.join(', ')}\nDemo staff password${process.env.SEED_DEMO_PASSWORD ? ' (from SEED_DEMO_PASSWORD)' : ` (shown once): ${demoPassword}`}`);
  else console.log('Demo staff already existed; passwords unchanged.');
}
