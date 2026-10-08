import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Principal } from './tenant-store.js';

export const READ_SCOPE = 'sam:opportunities:read';
export const ADMIN_SCOPE = 'sam:credentials:write';
export type VerifiedPrincipal = Principal & { scopes: string[] };
export type VerifyToken = (token: string) => Promise<VerifiedPrincipal>;

/** Resource-server verifier. A tenant ID supplied by the caller is never trusted. */
export function tokenVerifier(config: { issuer: string; audience: string; jwksUri: string }, keyResolver?: JWTVerifyGetKey): VerifyToken {
  for (const value of [config.issuer, config.audience, config.jwksUri]) {
    if (new URL(value).protocol !== 'https:') throw new Error('OAuth configuration URLs must use HTTPS.');
  }
  const resolver = keyResolver ?? createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 5000 });
  return async token => {
    const { payload } = await jwtVerify(token, resolver, {
      issuer: config.issuer, audience: config.audience,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    });
    const clientId = payload.client_id ?? payload.azp;
    if (!payload.sub || typeof clientId !== 'string' || !clientId || typeof payload.scope !== 'string') throw new Error('Invalid access token.');
    if (payload.client_id && payload.azp && payload.client_id !== payload.azp) throw new Error('Ambiguous authorized client.');
    return { issuer: config.issuer, subject: payload.sub, clientId, scopes: payload.scope.split(/\s+/).filter(Boolean) };
  };
}
