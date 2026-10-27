import { buildConfig, loadEnvFile } from '../config.js';
import { Database } from '../db/database.js';

loadEnvFile();
const config = buildConfig();
const db = new Database(config.databaseFile);
const applied = db.migrate(message => console.log(message));
console.log(applied.length ? `Database is up to date (${applied.length} migration(s) applied).` : 'Database is already up to date.');
db.close();
