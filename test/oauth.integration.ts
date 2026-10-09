import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import pg from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { CookieJar } from 'tough-cookie';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { KeyVault } from '../src/encryption.js';
import { TenantStore } from '../src/tenant-store.js';
import { OAuthStore } from '../src/oauth-store.js';
import { createBroker } from '../src/oauth.js';
import { createApp } from '../src/app.js';
import { READ_SCOPE } from '../src/auth.js';
import { createLogin } from '../src/better-login.js';

for (const publicClient of [false, true])
  test(
    `full ${publicClient ? 'Inspector public PKCE' : 'confidential'} OAuth flow, tenant key entry, MCP call, refresh, replay rejection, and revocation across server instances`,
    { timeout: 60000 },
    async () => {
      assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required; run npm run verify');
      const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
      const vault = new KeyVault('test', { test: randomBytes(32).toString('base64') });
      const tenants = new TenantStore(pool, vault),
        store = new OAuthStore(pool, vault);
      await tenants.migrate();
      await store.migrate();
      const signing = await generateKeyPair('RS256', { extractable: true });
      const jwk = {
        ...(await exportJWK(signing.privateKey)),
        kid: 'integration',
        use: 'sig',
        alg: 'RS256',
      };
      const cookieKeys = [randomBytes(32).toString('base64url')];
      const tenantId = randomUUID(),
        otherTenantId = randomUUID(),
        clientId = randomUUID(),
        otherClientId = randomUUID(),
        clientSecret = randomBytes(32).toString('base64url');
      const receivedKeys: string[] = [];
      let route: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
      const http = createServer((req, res) => {
        void route(req, res).catch(() => {
          res.statusCode = 500;
          res.end('Test request failed.');
        });
      });
      http.listen(0, '127.0.0.1');
      await once(http, 'listening');
      const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
      const callbackUrl = publicClient
        ? 'http://127.0.0.1:6276/client-callback'
        : `${origin}/client-callback`;
      let email = `admin-${randomUUID()}@org-a.example`;
      const login = createLogin(pool, origin, randomBytes(32).toString('base64url'));
      await login.migrate();
      const options = {
        publicUrl: origin,
        store,
        tenants,
        jwks: { keys: [jwk] },
        cookieKeys,
        allowLocalHttp: true,
        login,
        fetcher: async (url: URL | RequestInfo) =>
          new URL(String(url)).searchParams.get('api_key') === 'rejected-test-secret'
            ? new Response(null, { status: 403 })
            : Response.json({ totalRecords: 0, opportunitiesData: [] }),
      };
      let broker = createBroker(options);
      function install() {
        const handler = toNodeHandler(
          createApp({
            publicUrl: origin,
            issuer: origin,
            verify: broker.verify,
            store: tenants,
            fetcher: async (url) => {
              receivedKeys.push(new URL(String(url)).searchParams.get('api_key')!);
              return Response.json({
                totalRecords: 1,
                opportunitiesData: [{ noticeId: 'a'.repeat(32), title: 'Integration opportunity' }],
              });
            },
          }),
        );
        route = async (req, res) => {
          if (new URL(req.url!, origin).pathname === '/mcp') await handler(req, res);
          else await broker.handle(req, res);
        };
      }
      install();
      const jar = new CookieJar();
      async function browser(url: string, init: RequestInit = {}) {
        const headers = new Headers(init.headers);
        headers.set('cookie', await jar.getCookieString(url));
        const res = await fetch(url, { ...init, headers, redirect: 'manual' });
        for (const c of res.headers.getSetCookie()) await jar.setCookie(c, url);
        return res;
      }
      async function follow(response: Response) {
        let res = response;
        for (let n = 0; n < 12 && res.status >= 300 && res.status < 400; n++) {
          const next = new URL(res.headers.get('location')!, origin);
          if (next.pathname === '/client-callback') return { res, callback: next };
          res = await browser(next.href);
        }
        return { res, callback: undefined };
      }
      const csrf = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)?.[1];
      const uid = (body: string) => /\/interaction\/([\w-]+)\/(?:login|confirm)/.exec(body)?.[1];
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const token = (params: Record<string, string>) =>
        fetch(`${origin}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            ...(publicClient ? {} : { client_secret: clientSecret }),
            ...params,
          }),
        });
      try {
        await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)', [
          tenantId,
          'Organization A',
          otherTenantId,
          'Organization B',
        ]);
        await pool.query(
          'INSERT INTO tenant_clients(issuer,client_id,tenant_id) VALUES($1,$2,$3),($1,$4,$5)',
          [origin, clientId, tenantId, otherClientId, otherTenantId],
        );
        await pool.query("INSERT INTO tenant_invites(tenant_id,email,role) VALUES($1,$2,'admin')", [
          tenantId,
          email,
        ]);
        for (const id of [clientId, otherClientId])
          await store.adapter('Client').upsert(id, {
            client_id: id,
            ...(publicClient ? {} : { client_secret: clientSecret, client_secret_expires_at: 0 }),
            client_name: publicClient ? 'Inspector Test' : 'Gemini Test',
            redirect_uris: [callbackUrl],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: publicClient ? 'none' : 'client_secret_post',
            application_type: publicClient ? 'native' : 'web',
            scope: `openid offline_access ${READ_SCOPE}`,
          });
        const discovery = await (await fetch(`${origin}/.well-known/openid-configuration`)).json();
        assert.equal(discovery.authorization_endpoint, `${origin}/oauth/authorize`);
        assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
        const parameters = {
          client_id: clientId,
          redirect_uri: callbackUrl,
          response_type: 'code',
          scope: `openid offline_access ${READ_SCOPE}`,
          resource: `${origin}/mcp`,
          state: 'client-state',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          prompt: 'consent',
        };
        const noPkce = { ...parameters } as Record<string, string>;
        delete noPkce.code_challenge;
        delete noPkce.code_challenge_method;
        const refused = await browser(`${origin}/oauth/authorize?${new URLSearchParams(noPkce)}`);
        assert.ok(
          refused.status >= 400 ||
            new URL(refused.headers.get('location')!, origin).searchParams.has('error'),
        );
        const start = await follow(
          await browser(`${origin}/oauth/authorize?${new URLSearchParams(parameters)}`),
        );
        const startBody = await start.res.text();
        assert.match(startBody, /Sign-in is managed by Better Auth/);
        const interaction = uid(startBody)!;
        const setupUrl = await login.setupLink(email, 'Integration Admin');
        const setupToken = new URLSearchParams(new URL(setupUrl).hash.slice(1)).get('token')!;
        const setupForm = await (await browser(`${origin}/account/setup`)).text();
        const setupResponse = await browser(`${origin}/account/setup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
          body: new URLSearchParams({
            csrf: csrf(setupForm)!,
            token: setupToken,
            password: 'strong-integration-password-123',
          }),
        });
        assert.equal(setupResponse.status, 200);
        assert.match(await setupResponse.text(), /Password saved/);
        await assert.rejects(() =>
          login.auth.api.resetPassword({
            body: { token: setupToken, newPassword: 'cannot-replay-this-password' },
          }),
        );
        assert.equal(
          (
            await browser(`${origin}/account/auth/sign-up/email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: 'attacker@example.com',
                password: 'long-password-1234',
                name: 'Attacker',
              }),
            })
          ).status,
          404,
        );
        const signIn = () =>
          browser(`${origin}/interaction/${interaction}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
            body: new URLSearchParams({
              csrf: csrf(startBody)!,
              email,
              password: 'strong-integration-password-123',
            }),
          });
        const signedIn = await follow(await signIn());
        assert.equal(
          signedIn.res.headers.get('referrer-policy'),
          'same-origin',
          'Browser form POST must retain its same-origin Origin header.',
        );
        assert.ok(
          signedIn.res.headers
            .get('content-security-policy')
            ?.includes(` ${new URL(callbackUrl).origin};`),
          'Consent form allows only the registered callback origin',
        );
        let consent = await signedIn.res.text();
        assert.match(consent, /Organization A/);
        assert.ok(consent.includes(`Authorize ${publicClient ? 'Inspector Test' : 'Gemini Test'}`));
        assert.match(consent, /SAM.gov system-account API key/);
        const consentId = uid(consent)!;
        const csrfRejected = await browser(`${origin}/interaction/${consentId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
          body: new URLSearchParams({
            csrf: 'invalid',
            decision: 'allow',
            api_key: 'attacker-key',
          }),
        });
        assert.equal(csrfRejected.status, 400);
        consent = await (await browser(`${origin}/interaction/${consentId}`)).text();
        // A key SAM.gov rejects re-shows the form with a fresh token instead of ending the flow.
        const rejectedKey = await browser(`${origin}/interaction/${consentId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
          body: new URLSearchParams({
            csrf: csrf(consent)!,
            decision: 'allow',
            api_key: 'rejected-test-secret',
          }),
        });
        assert.equal(rejectedKey.status, 400);
        consent = await rejectedKey.text();
        assert.match(consent, /SAM.gov rejected this key/);
        assert.ok(!consent.includes('rejected-test-secret'));
        const submitted = await browser(`${origin}/interaction/${consentId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
          body: new URLSearchParams({
            csrf: csrf(consent)!,
            decision: 'allow',
            api_key: 'org-a-test-secret',
          }),
        });
        const authorized = await follow(submitted);
        assert.ok(authorized.callback, `Expected callback; got ${await authorized.res.text()}`);
        assert.equal(authorized.callback.searchParams.get('state'), 'client-state');
        const code = authorized.callback.searchParams.get('code')!;
        assert.ok(code);
        // Persisted code is redeemable by a fresh authorization server instance.
        broker = createBroker(options);
        install();
        const wrongVerifier = await token({
          grant_type: 'authorization_code',
          code,
          code_verifier: 'x'.repeat(43),
          redirect_uri: callbackUrl,
        });
        assert.equal(wrongVerifier.status, 400);
        const tokensRes = await token({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: callbackUrl,
        });
        const tokens = await tokensRes.json();
        assert.equal(tokensRes.status, 200, JSON.stringify(tokens));
        assert.ok(tokens.access_token);
        assert.ok(tokens.refresh_token);
        assert.ok(!JSON.stringify(tokens).includes('org-a-test-secret'));
        const rpc = async (bearer: string) =>
          fetch(`${origin}/mcp`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${bearer}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2026-07-28',
              'Mcp-Method': 'tools/call',
              'Mcp-Name': 'get_sam_opportunities',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'get_sam_opportunities',
                arguments: { posted_from: '10/01/2026', posted_to: '10/07/2026' },
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientInfo': { name: 'integration', version: '1' },
                  'io.modelcontextprotocol/clientCapabilities': {},
                },
              },
            }),
          });
        const search = await rpc(tokens.access_token);
        assert.equal(search.status, 200);
        assert.equal((await search.json()).result.structuredContent.total, 1);
        assert.deepEqual(receivedKeys, ['org-a-test-secret']);
        for (const mode of ['legacy', { pin: '2026-07-28' }] as const) {
          const sdk = new Client(
            { name: 'official-sdk-test', version: '1' },
            { versionNegotiation: { mode } },
          );
          try {
            await sdk.connect(
              new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
              }),
            );
            assert.equal((await sdk.listTools()).tools.length, 2);
            const result = await sdk.callTool({
              name: 'get_sam_opportunities',
              arguments: { posted_from: '10/01/2026', posted_to: '10/07/2026' },
            });
            assert.equal(result.isError, undefined);
          } finally {
            await sdk.close();
          }
        }
        const refreshedRes = await token({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        });
        const refreshed = await refreshedRes.json();
        assert.equal(refreshedRes.status, 200, JSON.stringify(refreshed));
        assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
        assert.equal((await rpc(refreshed.access_token)).status, 200);
        const principal = await broker.verify(tokens.access_token);
        assert.equal(await tenants.keyFor({ ...principal, clientId: otherClientId }), undefined);
        assert.equal(await tenants.setKey(principal, 'replacement-org-a-secret'), true);
        assert.equal((await rpc(tokens.access_token)).status, 200);
        assert.equal(receivedKeys.at(-1), 'replacement-org-a-secret');
        const secondStore = new OAuthStore(pool, vault);
        const bucket = `test:${randomUUID()}`;
        assert.equal(await store.allow(bucket, 1, 60), true);
        assert.equal(await secondStore.allow(bucket, 1, 60), false);
        await pool.query('UPDATE tenant_memberships SET enabled=false WHERE tenant_id=$1', [
          tenantId,
        ]);
        assert.equal((await rpc(tokens.access_token)).status, 403);
        await pool.query('UPDATE tenant_memberships SET enabled=true WHERE tenant_id=$1', [
          tenantId,
        ]);
        const revoke = await fetch(`${origin}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            ...(publicClient ? {} : { client_secret: clientSecret }),
            token: refreshed.access_token,
            token_type_hint: 'access_token',
          }),
        });
        assert.equal(revoke.status, 200);
        assert.equal((await rpc(refreshed.access_token)).status, 401);
        assert.equal(
          (await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))
            .status,
          400,
        );
        assert.equal(
          (
            await token({
              grant_type: 'authorization_code',
              code,
              code_verifier: verifier,
              redirect_uri: callbackUrl,
            })
          ).status,
          400,
        );
        const recoveryLink = await login.setupLink(email, 'Integration Admin');
        await login.auth.api.resetPassword({
          body: {
            token: new URLSearchParams(new URL(recoveryLink).hash.slice(1)).get('token')!,
            newPassword: 'recovered-password-123456',
          },
        });
        assert.equal(
          (await rpc(tokens.access_token)).status,
          401,
          'Password recovery revokes delegated OAuth access',
        );
        email = `uninvited-${randomUUID()}@org-b.example`;
        await login.auth.api.createUser({
          body: { email, name: 'Uninvited', password: 'strong-integration-password-123' },
        });
        const outsiderStart = await follow(
          await browser(
            `${origin}/oauth/authorize?${new URLSearchParams({ ...parameters, prompt: 'login consent' })}`,
          ),
        );
        const outsiderBody = await outsiderStart.res.text(),
          outsiderId = uid(outsiderBody)!;
        const outsider = await follow(
          await browser(`${origin}/interaction/${outsiderId}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
            body: new URLSearchParams({
              csrf: csrf(outsiderBody)!,
              email,
              password: 'strong-integration-password-123',
            }),
          }),
        );
        assert.equal(outsider.res.status, 403);
        assert.match(await outsider.res.text(), /Organization access required/);
      } finally {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
        await pool.query('DELETE FROM tenants WHERE id IN ($1,$2)', [tenantId, otherTenantId]);
        await pool.end();
      }
    },
  );
