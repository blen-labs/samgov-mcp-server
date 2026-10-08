import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { KeyVault } from './encryption.js';
import { TenantStore } from './tenant-store.js';
import { OAuthStore } from './oauth-store.js';
import { READ_SCOPE } from './auth.js';
import { createLogin } from './better-login.js';
import type { AdapterPayload } from 'oidc-provider';

// Operator-only CLI: secrets are written to a new private file, never stdout.
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const publicUrl = new URL(process.env.PUBLIC_URL!).origin;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const vault = new KeyVault(process.env.ACTIVE_ENCRYPTION_KEY_ID!, JSON.parse(process.env.ENCRYPTION_KEYS_JSON!));
  const tenants = new TenantStore(pool, vault), oauth = new OAuthStore(pool, vault);
  try {
    await tenants.migrate(); await oauth.migrate();
    if (command === 'setup-account') {
      const [email, name, output] = args;
      if (!email || !name || !output) throw new Error('Usage: setup-account EMAIL NAME NEW_PRIVATE_OUTPUT_FILE');
      const invited = await pool.query(`SELECT 1 FROM tenant_invites i JOIN tenants t ON t.id=i.tenant_id WHERE i.email=$1 AND t.enabled
        UNION SELECT 1 FROM accounts a JOIN tenant_memberships m ON m.subject=a.id::text JOIN tenants t ON t.id=m.tenant_id WHERE a.email=$1 AND a.enabled AND m.enabled AND t.enabled`, [email.toLowerCase()]);
      if (!invited.rowCount) throw new Error('An active organization invitation or membership is required.');
      await writeFile(output, '{}\n', { flag: 'wx', mode: 0o600 });
      const login = createLogin(pool, publicUrl, process.env.BETTER_AUTH_SECRET!);
      await login.migrate();
      const url = await login.setupLink(email, name);
      await writeFile(output, JSON.stringify({ email, setup_url: url, expires_in_seconds: 3600 }, null, 2)+'\n', { mode: 0o600 });
      console.log(`Private account setup link saved to ${output}. No email was sent.`);
    } else if (command === 'create-tenant') {
      const [name, email, output] = args;
      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !output) throw new Error('Usage: create-tenant NAME ADMIN_EMAIL NEW_PRIVATE_OUTPUT_FILE');
      const id = randomUUID(), clientId = randomUUID(), secret = randomBytes(32).toString('base64url');
      const metadata: AdapterPayload = { client_id: clientId, client_secret: secret, client_secret_expires_at: 0, client_name: `${name} Gemini Enterprise`, redirect_uris: ['https://vertexaisearch.cloud.google.com/oauth-redirect'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post', application_type: 'web', scope: `openid offline_access ${READ_SCOPE}` };
      // Reserve the output first so accidental overwrites fail before database mutations.
      await writeFile(output, JSON.stringify({ tenant_id: id, mcp_url: `${publicUrl}/mcp`, authorization_url: `${publicUrl}/oauth/authorize`, token_url: `${publicUrl}/oauth/token`, scopes: metadata.scope, pkce: true, client_id: clientId, client_secret: secret }, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[id,name]);
        await client.query('INSERT INTO tenant_clients(issuer,client_id,tenant_id) VALUES($1,$2,$3)',[publicUrl,clientId,id]);
        await client.query("INSERT INTO tenant_invites(tenant_id,email,role) VALUES($1,$2,'admin')",[id,email.toLowerCase()]);
        await client.query('COMMIT');
      } catch(e) { await client.query('ROLLBACK'); throw e; } finally {client.release();}
      await oauth.adapter('Client').upsert(clientId, metadata);
      console.log(`Tenant created. Connector configuration saved privately to ${output}.`);
    } else if (command === 'create-inspector-client') {
      const [tenantId, output] = args;
      if (!tenantId || !output) throw new Error('Usage: create-inspector-client TENANT_ID NEW_PRIVATE_OUTPUT_FILE');
      const tenant = await pool.query<{name:string}>('SELECT name FROM tenants WHERE id=$1 AND enabled', [tenantId]);
      if (!tenant.rows[0]) throw new Error('Active tenant required.');
      const clientId = randomUUID();
      const metadata: AdapterPayload = { client_id: clientId, client_name: `${tenant.rows[0].name} Development Inspector`, redirect_uris: ['http://127.0.0.1:6274/oauth/callback', 'http://localhost:6274/oauth/callback', 'http://127.0.0.1:6276/oauth/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native', scope: `openid offline_access ${READ_SCOPE}` };
      await writeFile(output, JSON.stringify({ mcpServers: { 'samgov-production': { type: 'http', url: `${publicUrl}/mcp`, protocolEra: 'modern', modernLogLevel: 'off', oauth: { clientId, scopes: metadata.scope } } } }, null, 2)+'\n', {flag:'wx',mode:0o600});
      await oauth.adapter('Client').upsert(clientId, metadata);
      await pool.query('INSERT INTO tenant_clients(issuer,client_id,tenant_id)VALUES($1,$2,$3)', [publicUrl, clientId, tenantId]);
      console.log(`Separate PKCE development client created; configuration saved to ${output}.`);
    } else if (command === 'invite') {
      const [tenantId,email,role='member'] = args;
      if (!tenantId || !email || !['member','admin'].includes(role)) throw new Error('Usage: invite TENANT_ID EMAIL [member|admin]');
      await pool.query('INSERT INTO tenant_invites(tenant_id,email,role) VALUES($1,$2,$3) ON CONFLICT(tenant_id,email) DO UPDATE SET role=EXCLUDED.role',[tenantId,email.toLowerCase(),role]);
      console.log('Invitation recorded. No email was sent.');
    } else if (command === 'disable-member') {
      const [tenantId,accountId] = args;
      await pool.query('UPDATE tenant_memberships SET enabled=false WHERE tenant_id=$1 AND subject=$2',[tenantId,accountId]);
      await oauth.revokeTenant(tenantId!,accountId);
      console.log('Membership disabled.');
    } else if (command === 'revoke-tenant') {
      const [tenantId] = args;
      await pool.query('UPDATE tenants SET enabled=false WHERE id=$1',[tenantId]);
      await oauth.revokeTenant(tenantId!);
      console.log('Tenant disabled; subsequent MCP access is denied.');
    } else if (command === 'list-tenants') {
      console.log(JSON.stringify((await pool.query('SELECT id,name,enabled FROM tenants ORDER BY name')).rows,null,2));
    } else if (command === 'list-members') {
      console.log(JSON.stringify((await pool.query('SELECT m.subject,a.email,m.role,m.enabled FROM tenant_memberships m LEFT JOIN accounts a ON a.id::text=m.subject WHERE m.tenant_id=$1',[args[0]])).rows,null,2));
    } else throw new Error('Commands: create-tenant, create-inspector-client, invite, setup-account, disable-member, revoke-tenant, list-tenants, list-members');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Management operation failed. Check arguments and configuration; secret details were suppressed.'); process.exitCode=1; });
