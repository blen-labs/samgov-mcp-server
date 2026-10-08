import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { KeyVault } from '../src/encryption.js';

test('tenant-bound encryption prevents copying ciphertext between organizations', () => {
  const vault = new KeyVault('v1', { v1: randomBytes(32).toString('base64') });
  const sealed = vault.seal('tenant-a', 'sam-secret');
  assert.ok(!JSON.stringify(sealed).includes('sam-secret'));
  assert.equal(vault.open('tenant-a', sealed), 'sam-secret');
  assert.throws(() => vault.open('tenant-b', sealed), /could not be decrypted/);
  assert.throws(() => vault.open('tenant-a', { ...sealed, ciphertext: Buffer.from('tamper').toString('base64') }), /could not be decrypted/);
  assert.notDeepEqual(vault.seal('tenant-a', 'sam-secret'), sealed);
});

test('key rotation preserves old decrypt capability and uses the active version for new writes', () => {
  const keys = { old: randomBytes(32).toString('base64'), next: randomBytes(32).toString('base64') };
  const before = new KeyVault('old', keys).seal('tenant', 'sam-secret');
  const after = new KeyVault('next', keys);
  assert.equal(after.open('tenant', before), 'sam-secret');
  assert.equal(after.seal('tenant', 'replacement').keyId, 'next');
  assert.throws(() => new KeyVault('missing', keys));
  assert.throws(() => new KeyVault('bad', { bad: 'password' }));
});
