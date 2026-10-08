import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK } from 'jose';
try {
  const [origin, output] = process.argv.slice(2);
  const url = new URL(origin);
  if (!output || url.protocol !== 'https:' || url.origin !== origin || /[\s'\\]/.test(origin))
    throw new Error();
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = {
    keys: [{ ...(await exportJWK(privateKey)), kid: 'v1', alg: 'RS256', use: 'sig' }],
  };
  const data = {
    PUBLIC_URL: origin,
    DATABASE_URL: '',
    AUTH_MODE: 'better-auth',
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    OAUTH_SIGNING_JWKS: JSON.stringify(jwks),
    OAUTH_COOKIE_KEYS: JSON.stringify([randomBytes(48).toString('base64url')]),
    ACTIVE_ENCRYPTION_KEY_ID: 'v1',
    ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: randomBytes(32).toString('base64') }),
    PORT: '3000',
  };
  await writeFile(
    output,
    Object.entries(data)
      .map(([k, v]) => `${k}='${v}'`)
      .join('\n') + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    'Created private configuration. Set DATABASE_URL and Google credentials before starting.',
  );
} catch {
  console.error(
    'Usage: node scripts/init-env.mjs https://service.example NEW_PRIVATE_FILE. Existing files are never replaced.',
  );
  process.exitCode = 1;
}
