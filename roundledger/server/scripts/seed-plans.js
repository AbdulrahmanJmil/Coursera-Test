// Inserts example subscription plans if none exist. Prices are placeholders:
// review and edit them in the dashboard before selling anything.
import { loadConfig } from '../src/config.js';
import { openDatabase, migrate } from '../src/db.js';

const db = openDatabase(loadConfig().databasePath);
migrate(db);
if (db.prepare('SELECT COUNT(*) AS n FROM plans').get().n) {
  console.log('Plans already exist; nothing to do.');
} else {
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO plans (code, name, description, price_cents, currency, duration_days, device_limit, features,
    is_active, is_featured, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`);
  ins.run('monthly', 'Monthly', 'Round history, statistics and cloud sync.', 0, 'USD', 30, 1, JSON.stringify({ aiAnalysis: false, cloudHistory: true }), 0, 10, now, now);
  ins.run('monthly-plus', 'Monthly Plus', 'Adds AI explanations of your statistics.', 0, 'USD', 30, 2, JSON.stringify({ aiAnalysis: true, cloudHistory: true }), 1, 20, now, now);
  console.log('Inserted 2 example plans as INACTIVE with price 0. Set prices and activate them in the dashboard.');
}
db.close();
