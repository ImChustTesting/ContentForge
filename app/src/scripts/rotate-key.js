// Re-encrypt every row in user_secrets from ENCRYPTION_KEY_OLD to ENCRYPTION_KEY.
// Usage:
//   ENCRYPTION_KEY_OLD=<old hex> ENCRYPTION_KEY=<new hex> \
//     docker compose run --rm app node src/scripts/rotate-key.js
//
// Idempotent — running twice is safe; rows are bumped to a new key_version each
// successful re-encrypt so a partial run can be resumed.

import { pool } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/encryption.js';

async function main() {
  const oldKey = process.env.ENCRYPTION_KEY_OLD;
  const newKey = process.env.ENCRYPTION_KEY;
  if (!oldKey || !newKey) {
    console.error('Set ENCRYPTION_KEY_OLD (current) and ENCRYPTION_KEY (new).');
    process.exit(2);
  }
  if (oldKey === newKey) {
    console.error('OLD and NEW are equal — nothing to do.');
    process.exit(2);
  }

  const { rows } = await pool.query(
    'SELECT user_id, anthropic_key, key_version FROM user_secrets'
  );

  let rotated = 0;
  for (const row of rows) {
    const plaintext = decrypt(row.anthropic_key, oldKey, row.key_version);
    const blob = encrypt(plaintext, newKey, row.key_version + 1);
    await pool.query(
      `UPDATE user_secrets
       SET anthropic_key = $1, key_version = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [blob, row.key_version + 1, row.user_id]
    );
    rotated++;
  }
  console.log(`rotated ${rotated} secret(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
