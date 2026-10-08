import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createLogin } from '../src/better-login.js';
import { OAuthStore } from '../src/oauth-store.js';
import { TenantStore } from '../src/tenant-store.js';
import { KeyVault } from '../src/encryption.js';

test('Better Auth persists hashed passwords, blocks signup and invalid credentials, and consumes recovery tokens once', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const origin = 'https://identity-test.example', secret = randomBytes(32).toString('base64url');
  const login = createLogin(pool, origin, secret);
  const email = `${randomUUID()}@example.com`, password = 'test-strong-password-1234';
  const vault = new KeyVault('test', { test: randomBytes(32).toString('base64') });
  await new TenantStore(pool, vault).migrate();
  await new OAuthStore(pool, vault).migrate();
  await login.migrate();
  let id: string | undefined;
  try {
    await assert.rejects(login.auth.api.signUpEmail({ body: { email, password, name: 'Uninvited' } }));
    const link = await login.setupLink(email, 'Test User');
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token')!;
    id = (await pool.query('SELECT id FROM ba_user WHERE email=$1', [email])).rows[0].id;
    assert.ok(token);
    await assert.rejects(login.auth.api.resetPassword({ body: { token, newPassword: 'short' } }));
    await login.auth.api.resetPassword({ body: { token, newPassword: password } });
    await assert.rejects(login.auth.api.resetPassword({ body: { token, newPassword: password } }));
    const stored = await pool.query('SELECT password FROM ba_account WHERE "userId"=$1', [id]);
    assert.notEqual(stored.rows[0].password, password);
    assert.ok(stored.rows[0].password.length > 64);
    await assert.rejects(login.auth.api.signInEmail({ body: { email, password: 'incorrect-password-1234' } }));
    const response = await login.auth.api.signInEmail({ body: { email, password }, asResponse: true });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    assert.ok(cookies.some(c => /HttpOnly/i.test(c) && /Secure/i.test(c)));
    const headers = new Headers({ cookie: cookies.map(c => c.split(';')[0]).join('; ') });
    assert.equal((await login.identity(headers))?.subject, id);
    assert.equal((await createLogin(pool, origin, secret).identity(headers))?.subject, id, 'Sessions survive a new service instance');
    assert.equal(await login.identity(new Headers({cookie:'better-auth.session_token=forged'})), undefined);
    const replacement = await login.setupLink(email, 'Test User');
    const resetToken = new URLSearchParams(new URL(replacement).hash.slice(1)).get('token')!;
    const attempts = await Promise.allSettled([1,2].map(() => login.auth.api.resetPassword({ body: { token: resetToken, newPassword: 'replacement-password-1234' } })));
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(await login.identity(headers), undefined, 'Recovery revokes prior Better Auth sessions');
    await assert.rejects(login.auth.api.signInEmail({ body: { email, password } }));
    const expired = await login.setupLink(email, 'Test User');
    await pool.query('UPDATE ba_verification SET "expiresAt"=now()-interval \'1 minute\' WHERE value=$1', [id]);
    await assert.rejects(login.auth.api.resetPassword({ body: { token: new URLSearchParams(new URL(expired).hash.slice(1)).get('token')!, newPassword: password } }));
  } finally {
    if (id) await pool.query('DELETE FROM ba_user WHERE id=$1', [id]);
    await pool.end();
  }
});
