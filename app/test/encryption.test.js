import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encrypt, decrypt } from '../src/lib/encryption.js';

const KEY = crypto.randomBytes(32).toString('hex');

test('round-trip: ascii', () => {
  const blob = encrypt('sk-ant-abcdef-1234567890', KEY);
  const out = decrypt(blob, KEY);
  assert.equal(out, 'sk-ant-abcdef-1234567890');
});

test('round-trip: unicode', () => {
  const plaintext = 'héllo 🐧 世界';
  const blob = encrypt(plaintext, KEY);
  assert.equal(decrypt(blob, KEY), plaintext);
});

test('round-trip: long plaintext', () => {
  const plaintext = 'A'.repeat(10_000);
  const blob = encrypt(plaintext, KEY);
  assert.equal(decrypt(blob, KEY), plaintext);
});

test('encrypt is non-deterministic (different IVs)', () => {
  const a = encrypt('same input', KEY);
  const b = encrypt('same input', KEY);
  assert.notDeepEqual(a, b);
});

test('decrypt rejects tampered ciphertext', () => {
  const blob = encrypt('hello', KEY);
  blob[14] ^= 0x01;
  assert.throws(() => decrypt(blob, KEY));
});

test('decrypt rejects wrong key', () => {
  const blob = encrypt('hello', KEY);
  const wrong = crypto.randomBytes(32).toString('hex');
  assert.throws(() => decrypt(blob, wrong));
});

test('rejects malformed master key', () => {
  assert.throws(() => encrypt('x', 'too-short'));
  assert.throws(() => encrypt('x', 'g'.repeat(64))); // not hex
});

test('round-trip with non-default version', () => {
  const blob = encrypt('hello', KEY, 7);
  assert.equal(decrypt(blob, KEY, 7), 'hello');
  assert.throws(() => decrypt(blob, KEY, 1));
});
