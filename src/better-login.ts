import { randomBytes } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { admin } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import type { Pool } from 'pg';

export type GoogleCredentials = { clientId: string; clientSecret: string };

export function createLogin(pool: Pool, publicUrl: string, secret: string, google?: GoogleCredentials) {
  const origin = new URL(publicUrl).origin;
  if (secret.length < 43) throw new Error('A strong persistent BETTER_AUTH_SECRET is required.');
  // Only the operator calls requestPasswordReset. Delivery is a private file, never email.
  const deliveries = new Map<string, string>();
  const config = {
    appName: 'SAM.gov MCP', baseURL: origin, basePath: '/account/auth', secret, database: pool,
    trustedOrigins: [origin], logger: { disabled: true },
    socialProviders: google ? { google: {
      clientId: google.clientId, clientSecret: google.clientSecret,
      redirectURI: `${origin}/account/auth/callback/google`,
      requireEmailVerification: true, disableIdTokenSignIn: true,
      disableDefaultScope: true, scope: ['openid', 'email', 'profile'],
      includeGrantedScopes: false, prompt: 'select_account',
      async mapProfileToUser(profile) {
        if (profile.email_verified !== true || typeof profile.email !== 'string') throw new APIError('FORBIDDEN', { message: 'Verified Google email required.' });
        const eligible = await pool.query(`SELECT 1 FROM tenant_invites i JOIN tenants t ON t.id=i.tenant_id WHERE i.email=$1 AND t.enabled
          UNION SELECT 1 FROM accounts a JOIN tenant_memberships m ON m.subject=a.id::text JOIN tenants t ON t.id=m.tenant_id
          WHERE a.upstream_issuer=$2 AND a.email=$1 AND a.enabled AND m.enabled AND t.enabled`, [profile.email.toLowerCase(), `${origin}/account`]);
        if (!eligible.rowCount) throw new APIError('FORBIDDEN', { message: 'Organization access required.' });
        return { email: profile.email.toLowerCase() };
      },
    } } : {},
    user: { modelName: 'ba_user' }, account: { modelName: 'ba_account', encryptOAuthTokens: true },
    verification: { modelName: 'ba_verification', storeIdentifier: 'hashed' },
    session: { modelName: 'ba_session', expiresIn: 86400, cookieCache: { enabled: false } },
    emailAndPassword: {
      enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: 3600,
      sendResetPassword: async ({ user, token }) => { deliveries.set(user.email, token); },
      onPasswordReset: async ({ user }) => {
        // Possession of the operator-delivered, one-use setup/recovery link
        // verifies the invited account before Google may link to it.
        await pool.query('UPDATE ba_user SET "emailVerified"=true WHERE id=$1', [user.id]);
        // Password recovery also invalidates previously delegated Gemini access.
        await pool.query(`DELETE FROM oauth_records WHERE model<>'Client' AND account_id IN
          (SELECT id::text FROM accounts WHERE upstream_issuer=$1 AND upstream_subject=$2)`, [`${origin}/account`, user.id]);
      },
    },
    advanced: { useSecureCookies: origin.startsWith('https:'), database: { generateId: 'uuid' } },
    plugins: [admin()],
  } satisfies BetterAuthOptions;
  let instance: ReturnType<typeof betterAuth<typeof config>> | undefined;
  const getAuth = () => instance ??= betterAuth(config);
  return {
    get auth() { return getAuth(); },
    googleEnabled: !!google,
    async migrate() {
      const lock = await pool.connect();
      try {
        await lock.query('SELECT pg_advisory_lock(739281058)');
        const plan = await getMigrations(config);
        await plan.runMigrations();
      } finally { await lock.query('SELECT pg_advisory_unlock(739281058)'); lock.release(); }
    },
    async setupLink(email: string, name: string) {
      const normalized = email.toLowerCase();
      const found = await pool.query('SELECT id FROM ba_user WHERE email=$1', [normalized]);
      if (!found.rowCount) await getAuth().api.createUser({ body: { email: normalized, name, password: randomBytes(48).toString('base64url') } });
      await getAuth().api.requestPasswordReset({ body: { email: normalized } });
      const token = deliveries.get(normalized); deliveries.delete(normalized);
      if (!token) throw new Error('Account setup could not be prepared.');
      return `${origin}/account/setup#token=${encodeURIComponent(token)}`;
    },
    async identity(headers: Headers) {
      const session = await getAuth().api.getSession({ headers });
      if (!session) return;
      // Operator-provisioned accounts or verified, invited Google identities only.
      // The immutable Better Auth subject is authoritative after first sign-in.
      return { issuer: `${origin}/account`, subject: session.user.id, email: session.user.email, verified: true };
    },
  };
}
export type BetterLogin = ReturnType<typeof createLogin>;
