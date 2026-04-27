import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PBKDF2_ITERS = 100_000;

function deriveKey(masterHex, version) {
  if (typeof masterHex !== 'string' || masterHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }
  if (!/^[0-9a-fA-F]+$/.test(masterHex)) {
    throw new Error('ENCRYPTION_KEY must be hex-encoded.');
  }
  const master = Buffer.from(masterHex, 'hex');
  const salt = Buffer.from(`contentforge-v${version}`, 'utf8');
  return crypto.pbkdf2Sync(master, salt, PBKDF2_ITERS, KEY_LEN, 'sha256');
}

export function encrypt(plaintext, masterHex, version = 1) {
  const key = deriveKey(masterHex, version);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function decrypt(blob, masterHex, version = 1) {
  if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Ciphertext too short.');
  }
  const key = deriveKey(masterHex, version);
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
