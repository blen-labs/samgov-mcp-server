import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import pg from 'pg';
import { createApp } from './app.js';
import { tokenVerifier } from './auth.js';
import { KeyVault } from './encryption.js';
import { TenantStore } from './tenant-store.js';
import { OAuthStore } from './oauth-store.js';
import { createBroker } from './oauth.js';
import { createLogin } from './better-login.js';
import { requestListener } from './http.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function main() {
  const publicUrl = required('PUBLIC_URL');
  const publicAddress = new URL(publicUrl);
  if (
    publicAddress.protocol !== 'https:' ||
    publicAddress.pathname !== '/' ||
    publicAddress.search ||
    publicAddress.hash ||
    publicAddress.username ||
    publicAddress.password
  )
    throw new Error('PUBLIC_URL must be an HTTPS origin.');
  const vault = new KeyVault(
    required('ACTIVE_ENCRYPTION_KEY_ID'),
    JSON.parse(required('ENCRYPTION_KEYS_JSON')),
  );
  const pool = new pg.Pool({
    connectionString: required('DATABASE_URL'),
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  pool.on('error', () => console.error('Database connection failure.'));
  const store = new TenantStore(pool, vault);
  await store.migrate();
  const oauth = new OAuthStore(pool, vault);
  await oauth.migrate();
  await oauth.cleanup();
  const cleanupTimer = setInterval(() => {
    void oauth.cleanup().catch(() => console.error('Expired record cleanup failed.'));
  }, 600000);
  cleanupTimer.unref();
  const mode = process.env.AUTH_MODE ?? 'better-auth';
  if (!['better-auth', 'external'].includes(mode)) throw new Error('Unsupported AUTH_MODE.');
  if (!!process.env.GOOGLE_CLIENT_ID !== !!process.env.GOOGLE_CLIENT_SECRET)
    throw new Error('Both Google OAuth credentials are required.');
  const google = process.env.GOOGLE_CLIENT_ID
    ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: required('GOOGLE_CLIENT_SECRET') }
    : undefined;
  const login =
    mode === 'better-auth'
      ? createLogin(pool, publicUrl, required('BETTER_AUTH_SECRET'), google)
      : undefined;
  await login?.migrate();
  const broker = login
    ? createBroker({
        publicUrl,
        store: oauth,
        tenants: store,
        jwks: JSON.parse(required('OAUTH_SIGNING_JWKS')),
        cookieKeys: JSON.parse(required('OAUTH_COOKIE_KEYS')),
        login,
      })
    : undefined;
  const issuer = broker ? publicAddress.origin : required('OAUTH_ISSUER');
  const verify =
    broker?.verify ??
    tokenVerifier({
      issuer,
      audience: `${publicAddress.origin}/mcp`,
      jwksUri: required('OAUTH_JWKS_URI'),
    });
  const handler = toNodeHandler(
    createApp({
      publicUrl,
      issuer,
      verify,
      store,
      allow: async (principal) => {
        const membership = await store.resolve(principal);
        return !!membership && (await oauth.allow(`tenant:${membership.tenantId}`, 60, 60));
      },
    }),
  );
  const server = createServer(requestListener(publicUrl, handler, broker?.handle));
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  server.listen(port, '0.0.0.0', () => console.log(`SAM.gov MCP listening on port ${port}.`));
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      clearInterval(cleanupTimer);
      server.close(() => {
        void pool.end().then(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
}

main().catch(() => {
  console.error(
    'Startup failed. Check the required configuration, OAuth URLs, encryption key format, and database connectivity.',
  );
  // Failed startup must terminate even if a pool/timer was already created.
  process.exit(1);
});
