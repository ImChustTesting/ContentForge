// Reset the admin password from the host.
// Usage: docker compose run --rm app node src/scripts/reset-password.js <new-password>

import { pool } from '../lib/db.js';
import { hashPassword, getOnlyUser } from '../lib/auth.js';

async function main() {
  const password = process.argv[2];
  if (!password || password.length < 8) {
    console.error('Usage: node src/scripts/reset-password.js <new-password>  (≥ 8 chars)');
    process.exit(2);
  }
  const user = await getOnlyUser();
  if (!user) {
    console.error('No user exists yet. Visit /setup in a browser instead.');
    process.exit(2);
  }
  const hash = await hashPassword(password);
  await pool.query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [hash, user.id]
  );
  console.log('admin password reset.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
