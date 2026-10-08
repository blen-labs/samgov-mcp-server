# SAM.gov opportunities MCP server

One hosted service, multiple organizations, one encrypted SAM.gov API key per tenant. The only tool is `get_sam_opportunities`, extracted from [Capture MCP](https://github.com/blencorp/capture-mcp-server). Other Data.gov APIs, entities, exclusions, and attachment downloads are outside its scope.

## Authentication and organization access

**Better Auth 1.7.7** manages Google sign-in, invite-only email/password accounts, and database-backed sessions. Google sign-in accepts invited Google accounts without requiring a Google Workspace domain. It requires a Google web OAuth client configured with `PUBLIC_URL/account/auth/callback/google`. `oidc-provider` handles the separate OAuth authorization server used by Gemini Enterprise: confidential clients, PKCE S256, consent, resource-bound opaque access tokens, rotating refresh tokens, and revocation. Better Auth is the login layer; this implementation does not use its OAuth Provider plugin.

1. The service operator creates a tenant and a confidential Gemini OAuth client, then invites an administrator.
2. Invited Google users select **Continue with Google**; their verified identity creates their account on first sign-in. Email/password users instead receive a private account setup link prepared by the operator. It expires after one hour, works once, and is delivered manually. The service sends no email. Password recovery uses the same operator-only command.
3. In Gemini, an invited user starts the connector, signs in, and authorizes access for the organization bound to that connector's OAuth client.
4. The tenant administrator enters the organization's SAM.gov key in the consent page. Members can use the stored key but cannot view or replace it.
5. Gemini receives its own OAuth token. Each MCP request checks the token, client-to-tenant binding, enabled membership, and tenant key.

Public email/password signup and Better Auth admin/account-linking APIs are not mounted. The only exposed Better Auth callback is Google’s callback; sign-in starts through a CSRF-protected form tied to the Gemini authorization request. Google email must be verified, and the account must have an active invitation or membership. Existing email/password accounts must first complete their private setup/recovery link before Google can link to them; the default protection against linking an unverified local account remains enabled. Passwords use Better Auth's password hashing; recovery revokes existing login sessions and delegated OAuth grants. Access does not depend on matching email domains. The tenant membership database remains authoritative; no caller-provided tenant ID or claim selects a key. Disabled memberships are checked on every tool request.

API keys and OAuth records are encrypted with AES-256-GCM, fresh nonces, and authenticated tenant/record binding. Encryption keys live in Railway secrets separately from PostgreSQL. Retain old key-ring entries until stored values have been re-encrypted. There is no global SAM.gov key fallback. Better Auth stores password hashes and session records in separate `ba_*` tables.

## Protocol and client configuration

Uses the stable TypeScript SDK v2 and [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28). Modern calls need no initialization or session identifier. The SDK's stateless legacy compatibility mode also accepts 2025-era initialization. GET/DELETE and subscriptions on `/mcp` are rejected. MCP requests need no sticky routing; credentials, identities, OAuth grants, and rate limits persist in PostgreSQL.

Configure Gemini Enterprise using the private file produced by `create-tenant`:

| Setting | Value |
| --- | --- |
| MCP URL | `PUBLIC_URL/mcp` |
| Authorization URL | `PUBLIC_URL/oauth/authorize` |
| Token URL | `PUBLIC_URL/oauth/token` |
| Redirect URI | `https://vertexaisearch.cloud.google.com/oauth-redirect` |
| Scopes | `openid offline_access sam:opportunities:read` |
| PKCE | Enabled, S256 |
| Client ID / secret | Unique confidential client for this tenant |

Follow Google's [custom MCP connector guide](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server), including the FQDN organization-policy allowlist. Google's guide does not specify the accepted MCP revision; passing SDK tests alone does not establish live Gemini acceptance.

## Operations

Requires Node.js 24 LTS and PostgreSQL. Set the variables in `.env.example` through the host's secret configuration. Do not put secrets in command arguments, source control, shell history, or logs.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public HTTPS origin |
| `DATABASE_URL` | Railway reference to the private PostgreSQL service |
| `AUTH_MODE` | `better-auth` (default) |
| `BETTER_AUTH_SECRET` | Persistent random secret of at least 43 characters |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google web OAuth credentials; set both to enable Google sign-in |
| `OAUTH_SIGNING_JWKS` | Persistent private signing-key set |
| `OAUTH_COOKIE_KEYS` | JSON array of persistent random cookie-signing keys |
| `ACTIVE_ENCRYPTION_KEY_ID` | Active encryption key-ring identifier |
| `ENCRYPTION_KEYS_JSON` | Secret map of identifiers to random 32-byte base64 keys |

Startup applies additive schema migrations under advisory locks. The Docker image runs as a non-root user and listens on Railway's `PORT`. `/healthz` reports process health, not successful SAM.gov or Gemini access.

Operator commands run with the same private environment as the service:

```sh
npm run manage -- create-tenant 'Organization Name' admin@example.com /private/new-connector.json
npm run manage -- setup-account admin@example.com 'Administrator Name' /private/new-setup.json
npm run manage -- invite TENANT_UUID member@example.com member
npm run manage -- setup-account member@example.com 'Member Name' /private/member-setup.json
npm run manage -- list-tenants
npm run manage -- list-members TENANT_UUID
npm run manage -- disable-member TENANT_UUID ACCOUNT_UUID
npm run manage -- revoke-tenant TENANT_UUID
```

In the production image use `node dist/manage.js` instead of `npm run manage --`. Output files must be new paths; they are created with mode 0600. Account setup links are credentials: deliver them privately to the intended person. The link's token is in the URL fragment and removed from browser history by the setup page. Setup and consent forms use bound, one-use CSRF tokens. Sign-in attempts are limited per email, OAuth traffic per connecting IP, and searches per tenant. Railway's proxy may aggregate IP-based quotas; per-email and per-tenant limits remain independent.

Optional `AUTH_MODE=external` supports an existing JWT authorization server using `OAUTH_ISSUER` and `OAUTH_JWKS_URI`. Tokens require RS256/ES256 signatures, exact issuer and `PUBLIC_URL/mcp` audience, subject, expiry, issued-at time, client ID, and scopes. Its separately provisioned admin tokens can call `POST /admin/credential` with `sam:credentials:write`; built-in Better Auth users manage keys through consent instead.

## Search behavior

The [GSA public opportunities API](https://open.gsa.gov/api/get-opportunities-public-api/) requires a SAM.gov personal key and posted dates in `MM/dd/yyyy`, with a maximum one-year range. Filters include title keyword, notice ID, solicitation number, organization name/code, procurement type, set-aside, state, NAICS, and classification code. `keyword` searches titles only. `offset` is a zero-based page index; use `next_offset` to continue. Results are limited to 100 per page. Upstream failures remain explicit tool errors, never empty successes.

Keys never appear in MCP schemas, tool results, or raw error messages. SAM.gov requires its key in the upstream query string, so outbound URL logging must remain disabled. Saving a key does not validate it with SAM.gov.

## Verification and remaining acceptance

```sh
npm ci
npm run check     # build + unit tests; the PG test skips without TEST_DATABASE_URL
npm run verify    # full suite inside Node 24 LTS, with isolated real PostgreSQL
npm run test:live-sam  # requires SAM_GOV_API_KEY from a private environment
```

The container suite covers Google authorization redirects and signed callback fixtures (state, PKCE, audience, email verification, invitation enforcement, account linking and replay), Better Auth account setup and password hashing, recovery replay/expiry/concurrency, real HTTP OAuth consent and PKCE, token persistence across server instances, refresh rotation, revoked/disabled access, tenant isolation, key replacement, encryption/tamper checks, upstream failures/redaction, and both modern and legacy official MCP clients. SAM.gov responses in the automated suite are simulated. Tests must never target the production database. Source fingerprints and sanitized gate results are written under ignored `.local/`.

Browser acceptance has completed using real Better Auth sign-in with a disposable local account and simulated SAM.gov data. A separate production browser test authenticated the invited BLEN administrator with Google and reached the tenant key-entry/consent page. The Google client is configured in Railway; its Cloud project is currently External / Testing, so broader organization rollout still needs audience and branding review. **End-to-end production acceptance remains incomplete:** live Google sign-in succeeded on October 7, 2026, reaching BLEN tenant consent with an enabled administrator membership; the live SAM.gov endpoint last returned HTTP 404, and the actual Gemini Enterprise connector has not completed a live search. A healthy Railway service or passing automated suite must not be reported as proof that those external integrations work.

## Development MCP Inspector

The official Inspector 2.10.1 is pinned as a dev dependency; it is excluded from the production runtime image. The UI runs locally and tests the deployed `/mcp` endpoint through the same Google sign-in, tenant membership, consent, and encrypted key lookup used by other clients.

Provision a separate public development client using the service's operator environment:

```sh
npm run manage -- create-inspector-client TENANT_UUID /private/inspector-config.json
```

Copy that output privately to `.local/inspector/config.json` on the developer machine, then run:

```sh
npm ci
npm run inspector
```

Open `http://127.0.0.1:6274` in the app browser and connect `samgov-production`. Sign in with an invited Google account and authorize the named Development Inspector client. A tenant administrator can add the organization's SAM.gov key on the consent screen. Do not enter a key in tool arguments or Inspector headers.

The separate client uses PKCE S256 with loopback redirects on ports 6274 (UI) and 6276 (CLI). It does not modify the Gemini client. The UI binds to 127.0.0.1 with API authentication enabled. OAuth tokens are encrypted in the ignored `.local/inspector` directory; its local encryption key must remain private. Stop the Inspector with Ctrl+C. Do not deploy it publicly.

After authorizing in the UI, run `npm run test:deployed` for a repeatable acceptance gate: modern and legacy discovery, no notification subscriptions, authorization denial, invalid input, live search, distinct pagination, and notice-ID lookup. It writes `.local/inspector-acceptance.json` and exits nonzero if any required gate fails. Use its stored OAuth state for individual CLI checks:

```sh
npm run inspector:cli -- --method tools/list --format json
npm run inspector:cli -- --method tools/call --tool-name get_sam_opportunities --tool-args-json '{"posted_from":"10/01/2026","posted_to":"10/08/2026","limit":2}' --format json
npm run inspector:cli -- --protocol-era legacy --method tools/list --format json
```

Choose current posted dates. A healthy deployment, successful OAuth, and tool discovery are separate from a successful live SAM.gov search. Confirm returned opportunities, a distinct next page, and a notice-ID lookup before marking live search accepted. Inspector acceptance does not establish Gemini Enterprise acceptance.

On October 8, 2026, Inspector browser testing found and fixed client-name consent labeling, the CSP callback redirect restriction, and the incorrectly advertised tool-list notification capability. The 19-test container suite passed with no skips. Real Inspector OAuth and both protocol modes reached production; a real search returned `UPSTREAM_ERROR` with SAM.gov HTTP 404. Direct local and Railway requests reproduced the empty upstream 404. Live search, pagination, and notice lookup therefore remain unaccepted pending upstream/key investigation.
