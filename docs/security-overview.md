# Security and data overview

A summary for vendor and security reviews of the hosted service. It describes what the code does; the details live in [architecture](./architecture.md), [operations](./operations.md), [SECURITY.md](../SECURITY.md), and the [privacy policy](../legal/privacy-policy.md). Items marked **operator to confirm** depend on the hosting account, not the code.

## Hosting and sub-processors

| Provider   | Role                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| Railway    | Runs the application container and PostgreSQL database. Region and plan: **operator to confirm**.        |
| Cloudflare | DNS for the custom domain.                                                                               |
| Google     | Optional sign-in (`openid`, `email`, `profile` scopes only).                                             |
| SAM.gov    | The only upstream API. Receives the organization's API key and search filters; never user tokens or IPs. |

No LLM runs in this service. Railway's own compliance attestations and uptime commitments: **operator to confirm**.

## Authentication and credentials

- MCP clients connect with OAuth 2.0 authorization code + PKCE. The service issues its own scoped, audience-bound tokens; Google tokens are never passed to the client.
- Access requires an operator-created organization and an invited, enabled membership. Public signup and dynamic client registration are disabled.
- Each organization's SAM.gov key is entered by its administrator during consent, checked with SAM.gov, and stored with AES-256-GCM application encryption bound to that tenant. The key stays on the server: it is never in tool arguments, tool results, or client storage.
- OAuth grants, tokens, and codes are stored encrypted; token IDs are hashed. Operators hold the encryption keys outside the database.

## Tenant isolation

- One shared service. The tenant is derived from the token's issuer, client, and subject; a tool argument or token claim cannot select another organization's key.
- Every request rechecks membership and tenant status before decrypting the key.
- Each organization has its own SAM.gov key and its own quotas, so one organization's usage does not consume another's SAM.gov quota.
- A dedicated single-organization deployment is possible by self-hosting (see [README](../README.md#self-hosting)).

## Data stored and not stored

- **Stored:** organization names, invited emails, names, memberships, sign-in and OAuth records, encrypted organization keys, and rate-limit counters.
- **Not stored:** search arguments, search results, or conversation content. There is no search-result cache; requests are processed in memory. The app does not log request contents, and suppresses upstream errors that could contain the key. Host-level logs depend on the operator's configuration.

## Usage safeguards

- 60 tool requests per organization per minute; 120 OAuth requests per IP per minute.
- A per-organization daily search cap (`TENANT_DAILY_SEARCH_LIMIT`, default 1000), with an operator log alert when it is reached.
- Repeated identical searches (more than 5 in 10 minutes) are refused, stopping assistant loops before they reach SAM.gov.
- SAM.gov retries are bounded (at most 3 attempts in 40 seconds) and honor SAM.gov's `Retry-After`; the service does not route around SAM.gov's quotas.

## Change monitoring

- CI runs format, lint, typecheck, unit and PostgreSQL integration tests, a dependency audit, and a credential scan on every change.
- A daily scheduled workflow checks the SAM.gov response format and core fields, failing on API changes or a rejected key and warning on outages.
- SAM.gov responses are validated at runtime; an unexpected format is reported as `INVALID_RESPONSE` rather than returned as partial data.
