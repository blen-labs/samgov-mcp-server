# Security policy

## Report privately

Do not disclose credentials or exploitable vulnerabilities in public issues. Use the repository's [private security advisory](https://github.com/blen-labs/samgov-mcp-server/security/advisories/new), once private reporting is enabled. If unavailable, contact the maintainers through the [BLEN Labs organization](https://github.com/blen-labs). Include a minimal synthetic reproduction and affected version; never send a production API key or database dump.

This project is in preview. Maintainers review reports without a published response-time guarantee. Use supported dependency versions and follow release notes before exposing a deployment to users.

## Threat model and boundaries

The service accepts untrusted MCP requests and third-party SAM.gov data. In-scope concerns include:

- Authentication, audience/scope, PKCE, callback, CSRF, or invitation bypass.
- Access to another organization's key, membership, or OAuth grant.
- Secret disclosure through logs, tool results, generated URLs, or release artifacts.
- HTTP request parsing crashes, arbitrary network targets, redirects, or unbounded response consumption.
- Replay, revocation, persistence, and release-workflow integrity failures.

Keys and OAuth payloads use authenticated encryption with tenant/record binding. Passwords are hashed by Better Auth. Provider tokens are encrypted. Better Auth's session/account tables still contain identifying and authentication-related data; protect the database and its backups. Operators possess the host keys and can decrypt credentials: a compromised operator, host, or dependency is outside the application-level isolation guarantee.

The SAM.gov key remains server-side. MCP arguments cannot supply it or choose a tenant. SAM.gov requires the key in its upstream query string; disable outbound URL logging in the host, proxy, and observability stack. Encrypt the database and backups at rest as an additional layer.

The fixed upstream destination and redirect rejection prevent caller-selected requests. Notice content remains untrusted. No user code is executed and no LLM operates within this server.

## Limits and operational requirements

The preview has not passed live SAM.gov search or actual Gemini Enterprise acceptance. Automated tests use upstream fixtures. Production load, backup restoration, and destructive migration/rollback testing remain operator gates. The OAuth socket-IP quota can aggregate behind proxies; configure trusted-edge controls as described in [operations](./docs/operations.md).

Production requires HTTPS, private database access or validated TLS, persistent host secrets, and organization provisioning by trusted operators. Inspector is development-only and must remain bound to loopback. Public signup and dynamic client registration are disabled.

CI checks dependency advisories, scans Git history for credentials, and pins workflow actions. These controls reduce known risks; they do not establish that the project has no vulnerabilities. Security-sensitive contributions require regression evidence.
