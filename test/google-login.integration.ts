import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { CookieJar } from 'tough-cookie';
import { createLogin } from '../src/better-login.js';
import { createBroker } from '../src/oauth.js';
import { KeyVault } from '../src/encryption.js';
import { OAuthStore } from '../src/oauth-store.js';
import { TenantStore } from '../src/tenant-store.js';

test('Better Auth Google sign-in verifies signed identity, invitations, OAuth state and PKCE, and links an existing invited account', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const vault = new KeyVault('test', { test: randomBytes(32).toString('base64') });
  const tenants = new TenantStore(pool, vault),
    store = new OAuthStore(pool, vault);
  await tenants.migrate();
  await store.migrate();
  let route: ReturnType<typeof createBroker>['handle'];
  const server = createServer((req, res) => {
    void route(req, res).catch(() => {
      res.statusCode = 500;
      res.end('Test request failed.');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const googleClient = 'synthetic-google-client',
    googleSecret = 'synthetic-google-secret';
  const login = createLogin(pool, origin, randomBytes(32).toString('base64url'), {
    clientId: googleClient,
    clientSecret: googleSecret,
  });
  await login.migrate();
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = {
    keys: [{ ...(await exportJWK(privateKey)), kid: 'signing', alg: 'RS256', use: 'sig' }],
  };
  const googleJwk = {
    ...(await exportJWK(publicKey)),
    kid: 'google-test',
    alg: 'RS256',
    use: 'sig',
  };
  route = createBroker({
    publicUrl: origin,
    store,
    tenants,
    jwks,
    cookieKeys: [randomBytes(32).toString('base64url')],
    allowLocalHttp: true,
    login,
    fetcher: async () => Response.json({ totalRecords: 0, opportunitiesData: [] }),
  }).handle;
  const tenantId = randomUUID(),
    clientId = randomUUID(),
    email = `google-${randomUUID()}@example.com`;
  let claims: Record<string, unknown> = {
    sub: randomUUID(),
    email,
    email_verified: true,
    name: 'Google test user',
  };
  let nonce: string | null = null,
    tokenCalls = 0,
    audience = googleClient;
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs')
      return Response.json({ keys: [googleJwk] });
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenCalls++;
      const body = new URLSearchParams(String(init?.body));
      assert.ok(body.get('code_verifier'));
      assert.equal(body.get('redirect_uri'), `${origin}/account/auth/callback/google`);
      assert.equal(body.get('client_secret'), googleSecret);
      const idToken = await new SignJWT({ ...claims, ...(nonce ? { nonce } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'google-test' })
        .setIssuer('https://accounts.google.com')
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({
        access_token: 'synthetic-google-access',
        id_token: idToken,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    return fetchOriginal(input, init);
  };
  async function flow(options: { tamperState?: boolean; dropCookie?: boolean } = {}) {
    const jar = new CookieJar();
    async function browser(url: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('cookie', await jar.getCookieString(url));
      const r = await fetch(url, { ...init, headers, redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) await jar.setCookie(c, url);
      return r;
    }
    async function follow(r: Response) {
      for (let i = 0; i < 10 && r.status >= 300 && r.status < 400; i++) {
        const target = new URL(r.headers.get('location')!, origin);
        if (target.origin !== origin) return r;
        r = await browser(target.href);
      }
      return r;
    }
    const start = await follow(
      await browser(
        `${origin}/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: `${origin}/callback`, response_type: 'code', scope: 'openid sam:opportunities:read', resource: `${origin}/mcp`, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'gemini-test-state', prompt: 'login consent' })}`,
      ),
    );
    assert.match(
      start.headers.get('content-security-policy') ?? '',
      /form-action 'self' https:\/\/accounts\.google\.com http:\/\/127\.0\.0\.1:\d+;/,
      'Browser form redirects must allow the configured Google authorization origin',
    );
    const html = await start.text();
    assert.match(html, /Continue with Google/);
    const uid = /\/interaction\/([\w-]+)\/google/.exec(html)![1],
      csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const signin = await browser(`${origin}/interaction/${uid}/google`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: csrf! }),
    });
    assert.equal(signin.status, 303);
    const target = new URL(signin.headers.get('location')!);
    assert.equal(target.origin, 'https://accounts.google.com');
    assert.equal(target.searchParams.get('redirect_uri'), `${origin}/account/auth/callback/google`);
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      target.searchParams.get('hd'),
      null,
      'Google accounts are not restricted to Workspace',
    );
    nonce = target.searchParams.get('nonce');
    const callback = `${origin}/account/auth/callback/google?${new URLSearchParams({ state: options.tamperState ? 'invalid' : target.searchParams.get('state')!, code: 'synthetic-google-code' })}`;
    const result = options.dropCookie
      ? await fetch(callback, { redirect: 'manual' })
      : await browser(callback);
    const final = await follow(result);
    return {
      status: final.status,
      body: await final.text(),
      callback,
      replay: () => browser(callback),
    };
  }
  try {
    await pool.query('INSERT INTO tenants(id,name)VALUES($1,$2)', [
      tenantId,
      'Google invitation test',
    ]);
    await pool.query('INSERT INTO tenant_clients(issuer,client_id,tenant_id)VALUES($1,$2,$3)', [
      origin,
      clientId,
      tenantId,
    ]);
    await pool.query("INSERT INTO tenant_invites(tenant_id,email,role)VALUES($1,$2,'admin')", [
      tenantId,
      email,
    ]);
    await store.adapter('Client').upsert(clientId, {
      client_id: clientId,
      client_secret: 'synthetic-client-secret-long-enough',
      client_secret_expires_at: 0,
      client_name: 'Test',
      redirect_uris: [`${origin}/callback`],
      response_types: ['code'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'client_secret_post',
      application_type: 'web',
      scope: 'openid sam:opportunities:read',
    });
    const existing = await login.auth.api.createUser({
      body: { email, name: 'Existing invited account', password: 'synthetic-password-1234' },
    });
    const invalidState = await flow({ tamperState: true });
    assert.notEqual(invalidState.status, 200);
    assert.equal(tokenCalls, 0);
    const missingCookie = await flow({ dropCookie: true });
    assert.notEqual(missingCookie.status, 200);
    assert.equal(tokenCalls, 0);
    audience = 'wrong-client';
    const wrongAudience = await flow();
    assert.notEqual(wrongAudience.status, 200);
    audience = googleClient;
    const pending = await flow();
    assert.notEqual(
      pending.status,
      200,
      'An unverified pre-existing account must not be implicitly linked',
    );
    const setup = await login.setupLink(email, 'Existing invited account');
    await login.auth.api.resetPassword({
      body: {
        token: new URLSearchParams(new URL(setup).hash.slice(1)).get('token')!,
        newPassword: 'verified-account-password-123',
      },
    });
    const success = await flow();
    assert.equal(success.status, 200, success.body);
    assert.match(success.body, /Authorize Test/);
    assert.match(success.body, /Google invitation test/);
    const links = await pool.query(
      'SELECT "userId", "accessToken" FROM ba_account WHERE "providerId"=$1 AND "accountId"=$2',
      ['google', claims.sub],
    );
    assert.equal(
      links.rows[0].userId,
      existing.user.id,
      'Verified Google identity links to the preprovisioned account',
    );
    assert.notEqual(
      links.rows[0].accessToken,
      'synthetic-google-access',
      'Provider credentials are encrypted',
    );
    const replay = await success.replay();
    assert.ok(replay.status >= 300);
    assert.match(replay.headers.get('location') ?? '', /error/);
    const newEmail = `fresh-google-${randomUUID()}@example.com`;
    await pool.query("INSERT INTO tenant_invites(tenant_id,email,role)VALUES($1,$2,'member')", [
      tenantId,
      newEmail,
    ]);
    claims = { ...claims, sub: randomUUID(), email: newEmail };
    const fresh = await flow();
    assert.equal(fresh.status, 200, fresh.body);
    assert.match(fresh.body, /Google invitation test/);
    await pool.query('DELETE FROM ba_user WHERE email=$1', [newEmail]);
    claims = { ...claims, sub: randomUUID(), email: `uninvited-${randomUUID()}@example.com` };
    const outsider = await flow();
    assert.notEqual(outsider.status, 200);
    assert.equal(
      (await pool.query('SELECT 1 FROM ba_user WHERE email=$1', [claims.email])).rowCount,
      0,
    );
    claims = { ...claims, email, email_verified: false };
    const unverified = await flow();
    assert.notEqual(unverified.status, 200);
    await pool.query('DELETE FROM ba_user WHERE id=$1', [existing.user.id]);
  } finally {
    globalThis.fetch = fetchOriginal;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    await pool.end();
  }
});
