// Creates an administrator, or promotes an existing user.
// Usage: node server/scripts/create-admin.js admin@example.com
// The password is read from ROUNDLEDGER_ADMIN_PASSWORD or prompted for.
import readline from 'node:readline';
import { loadConfig } from '../src/config.js';
import { openDatabase, migrate } from '../src/db.js';
import { createUser } from '../src/services/auth.js';
import { audit } from '../src/audit.js';
import { EMAIL_RE } from '../src/validate.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!EMAIL_RE.test(email)) {
  console.error('Usage: node server/scripts/create-admin.js <email>');
  process.exit(1);
}

async function promptHidden(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (!s.includes(q)) rl.output.write(''); else rl.output.write(s); };
  const answer = await new Promise((resolve) => rl.question(q, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const config = loadConfig();
const db = openDatabase(config.databasePath);
migrate(db);
const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
  audit(db, { actor: { email: 'cli' }, action: 'user.promote_admin', resourceType: 'user', resourceId: existing.id });
  console.log(`Promoted existing user ${email} (id ${existing.id}) to admin.`);
} else {
  const password = process.env.ROUNDLEDGER_ADMIN_PASSWORD || (await promptHidden('Password (10+ chars, letters and numbers): '));
  try {
    const id = createUser(db, { email, password, role: 'admin' });
    audit(db, { actor: { email: 'cli' }, action: 'user.create_admin', resourceType: 'user', resourceId: id });
    console.log(`Created admin ${email} (id ${id}).`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
db.close();
