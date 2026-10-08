# Architecture

```text
Invited user ── Google / Better Auth ── organization membership
                                          │
MCP client ── OAuth code + PKCE ── consent ─┘
    │
    └── bearer token ── /mcp ── tenant/key lookup ── SAM.gov API
                               │
                               └── PostgreSQL + application encryption
```

`better-login.ts` owns account sign-in. `oauth.ts` is the downstream OAuth authorization server, backed by oidc-provider. These are separate flows: Google's token identifies a user to this service; the service issues its own scoped, audience-bound token to the MCP client. Google tokens are never passed to Gemini.

`tenant_clients` binds a registered OAuth client to an organization. A user must have enabled membership in that organization. The service derives the tenant from issuer, client ID, and authenticated subject; a tenant identifier in a tool argument or JWT claim cannot select a key. OAuth records are durable and encrypted. Each MCP request rechecks current membership and tenant status before reading the encrypted key.

The MCP handler is created per request. Modern clients use discovery and direct tool calls; legacy clients can initialize without acquiring a session ID. The tool list is fixed and advertises `listChanged: false`. No subscriptions, server-initiated interactions, resumable streams, or process-local sessions are provided. The legacy SDK can encode a finite response as SSE; that does not create a persistent session.

SAM.gov is the sole upstream search destination. The server constructs its URL from an explicit filter mapping, rejects redirects, and bounds time and response size. It returns selected public fields instead of arbitrary upstream links. No LLM is used by this server.

## Persistence

- `tenants`, `tenant_clients`, `tenant_memberships`, `tenant_invites`: authorization and operator-created invitations.
- `tenant_keys`: AES-256-GCM encrypted organization credentials with tenant-bound authenticated data.
- `accounts`: immutable Better Auth subject mapping to the service's account ID.
- `oauth_records`: encrypted clients, grants, tokens, authorization codes, and temporary form state; token IDs are hashed for lookup.
- `rate_windows`: PostgreSQL-backed quotas shared across replicas.
- `ba_*`: Better Auth accounts, hashed passwords, provider credentials, and login sessions.

Migrations run under advisory locks. Atomic consumption protects one-time codes and CSRF state. Expired OAuth/rate records are cleaned every ten minutes. PostgreSQL backups and persistent host secrets are operator responsibilities; source releases do not include credentials or data.
