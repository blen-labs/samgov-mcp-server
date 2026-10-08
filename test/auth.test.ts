import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { tokenVerifier } from '../src/auth.js';

test('verifies audience, issuer, signature, expiry, and authorized client; ignores tenant claims', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  const config = {
    issuer: 'https://issuer.example',
    audience: 'https://mcp.example/mcp',
    jwksUri: 'https://issuer.example/jwks',
  };
  const verify = tokenVerifier(config, async () => publicKey);
  const claims = {
    iss: config.issuer,
    aud: config.audience,
    sub: 'alice',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    client_id: 'gemini-a',
    scope: 'sam:opportunities:read',
    tenant_id: 'attacker-selected-tenant',
  };
  const sign = (payload: object, key = privateKey) =>
    new SignJWT({ ...payload }).setProtectedHeader({ alg: 'ES256' }).sign(key);
  const principal = await verify(await sign(claims));
  assert.deepEqual(principal, {
    issuer: config.issuer,
    subject: 'alice',
    clientId: 'gemini-a',
    scopes: ['sam:opportunities:read'],
  });
  for (const change of [
    { iss: 'https://evil.example' },
    { aud: 'another-service' },
    { exp: 1 },
    { scope: undefined },
    { client_id: undefined },
    { azp: 'another-client' },
  ]) {
    await assert.rejects(verify(await sign({ ...claims, ...change })));
  }
  await assert.rejects(verify(await sign(claims, other.privateKey)));
});
