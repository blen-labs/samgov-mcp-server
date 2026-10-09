import { VERSION } from './version.js';
import { ADMIN_SCOPE, READ_SCOPE, type VerifyToken, type VerifiedPrincipal } from './auth.js';
import { createSamMcp } from './mcp.js';
import { saveSamKey, type Fetch } from './opportunities.js';
import type { TenantStore } from './tenant-store.js';

type Store = Pick<TenantStore, 'resolve' | 'keyRecord' | 'setKey'>;

export function createApp(config: {
  publicUrl: string;
  issuer: string;
  verify: VerifyToken;
  store: Store;
  fetcher?: Fetch;
  allow?: (principal: VerifiedPrincipal) => Promise<boolean>;
}) {
  const origin = new URL(config.publicUrl).origin;
  const resource = `${origin}/mcp`;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      },
    });
  const unauthorized = () =>
    json({ error: 'unauthorized' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    });
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        const requestOrigin = request.headers.get('origin');
        if (requestOrigin && requestOrigin !== origin)
          return json({ error: 'origin_not_allowed' }, 403);
        if (url.pathname === '/healthz' && request.method === 'GET')
          return json({ status: 'ok', version: VERSION });
        if (
          url.pathname === '/.well-known/oauth-protected-resource/mcp' &&
          request.method === 'GET'
        ) {
          return json({
            resource,
            authorization_servers: [config.issuer],
            scopes_supported: [READ_SCOPE],
            bearer_methods_supported: ['header'],
            resource_name: 'SAM.gov opportunities',
          });
        }
        if (!['/mcp', '/admin/credential'].includes(url.pathname))
          return json({ error: 'not_found' }, 404);
        if (url.search) return json({ error: 'query_parameters_not_allowed' }, 400);
        if (request.method !== 'POST')
          return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
        const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(
          request.headers.get('authorization') ?? '',
        );
        if (!match?.[1]) return unauthorized();
        let principal: VerifiedPrincipal;
        try {
          principal = await config.verify(match[1]);
        } catch {
          return unauthorized();
        }
        const requiredScope = url.pathname === '/mcp' ? READ_SCOPE : ADMIN_SCOPE;
        if (!principal.scopes.includes(requiredScope))
          return json({ error: 'insufficient_scope' }, 403, {
            'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
        if (url.pathname === '/admin/credential') {
          const member = await config.store.resolve(principal);
          if (!member || member.role !== 'admin') return json({ error: 'forbidden' }, 403);
          if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
            return json({ error: 'unsupported_media_type' }, 415);
          // Bound actual streaming bytes, not only attacker-controlled Content-Length.
          const reader = request.body?.getReader();
          if (!reader) return json({ error: 'invalid_request' }, 400);
          let body: unknown;
          try {
            const chunks: Uint8Array[] = [];
            let size = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 8192) return json({ error: 'request_too_large' }, 413);
              chunks.push(value);
            }
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return json({ error: 'invalid_request' }, 400);
          } finally {
            await reader.cancel();
          }
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).join() !== 'api_key'
          )
            return json({ error: 'invalid_request' }, 400);
          const key = (body as { api_key?: unknown }).api_key;
          const result =
            typeof key === 'string'
              ? await saveSamKey(key, (k) => config.store.setKey(principal, k), config.fetcher)
              : ({ status: 'invalid_format' } as const);
          if (result.status === 'invalid_format')
            return json({ error: 'invalid_credential_format' }, 400);
          if (result.status === 'rejected')
            return json({ error: 'credential_rejected', message: result.message }, 422);
          if (result.status === 'forbidden') return json({ error: 'forbidden' }, 403);
          return json({
            saved: true,
            upstream_verified: result.verified,
            ...(result.warning ? { warning: result.warning } : {}),
          });
        }
        const credential = await config.store.keyRecord(principal);
        if (!credential) return json({ error: 'tenant_access_or_credential_unavailable' }, 403);
        if (config.allow && !(await config.allow(principal)))
          return json({ error: 'tenant_rate_limit' }, 429, { 'Retry-After': '60' });
        // Restrict this server to finite request/response methods. No subscription stream is exposed.
        let parsed: Record<string, unknown>;
        const reader = request.body?.getReader();
        if (!reader) return json({ error: 'invalid_request' }, 400);
        try {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) return json({ error: 'request_too_large' }, 413);
            chunks.push(value);
          }
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return json({ error: 'invalid_request' }, 400);
        } finally {
          await reader.cancel();
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return json({ error: 'invalid_request' }, 400);
        if (
          ![
            'initialize',
            'notifications/initialized',
            'notifications/cancelled',
            'ping',
            'server/discover',
            'tools/list',
            'tools/call',
          ].includes(String(parsed.method))
        ) {
          return json(
            {
              jsonrpc: '2.0',
              id: parsed.id ?? null,
              error: { code: -32601, message: 'Method not supported by this server.' },
            },
            400,
          );
        }
        const mcp = createSamMcp(credential.key, config.fetcher, { savedAt: credential.savedAt });
        try {
          const response = await mcp.fetch(request, { parsedBody: parsed });
          // Fully consume finite JSON/SSE responses before closing per-request SDK resources.
          // This service exposes no subscriptions or server-initiated interaction.
          const body = await response.arrayBuffer();
          const headers = new Headers(response.headers);
          headers.set('Cache-Control', 'no-store');
          return new Response(body.byteLength ? body : null, { status: response.status, headers });
        } finally {
          await mcp.close();
        }
      } catch {
        // Do not expose database errors, raw JWTs, upstream URLs, or credential values.
        return json({ error: 'service_unavailable' }, 503);
      }
    },
  };
}
