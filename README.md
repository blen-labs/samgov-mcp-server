# SAM.gov MCP Server

[![CI](https://github.com/blen-labs/samgov-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/blen-labs/samgov-mcp-server/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-24%20LTS-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-7c3aed.svg)](https://modelcontextprotocol.io/specification/2026-07-28)

**Search U.S. federal contract opportunities from your AI assistant, using your organization's own SAM.gov API key.**

A hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the [SAM.gov public opportunities API](https://open.gsa.gov/api/get-opportunities-public-api/). One deployment serves multiple organizations. Google sign-in is handled by Better Auth; organization invitations and membership checks control access. Each organization's key is encrypted separately and used only on the server.

> **Preview status:** automated tests and deployed Inspector authentication pass. Live SAM.gov searches returned an empty upstream HTTP 404 on October 8, 2026, and the actual Gemini Enterprise connector has not completed acceptance. This is not yet a production-validated release. See [verification status](./docs/verification.md).

Independent open-source software, not affiliated with or endorsed by the U.S. government.

## What you can ask

- “Find recent SAM.gov opportunities with ‘software’ in the title.”
- “Show Virginia opportunities under NAICS 541512 posted this week.”
- “Get the next page of these opportunities.”
- “Find the opportunity with this notice ID.”

The assistant translates the question into `get_sam_opportunities`. The server validates the filters, selects the key belonging to the authenticated organization, and calls SAM.gov. It does not run an LLM or execute user-supplied code.

## Features

- **SAM.gov opportunities only:** title, organization, NAICS, state, procurement type, set-aside, solicitation number, and notice-ID filters.
- **Bring your own key:** one encrypted SAM.gov credential per organization, shared by its authorized members.
- **Google sign-in:** an invited, verified Google account signs in through Better Auth. Workspace is not required. Operator-managed password setup is also available.
- **Stateless MCP:** MCP `2026-07-28` request/response transport, plus stateless legacy compatibility. No sticky routing or MCP session IDs.
- **Durable authorization:** PostgreSQL stores tenant memberships, encrypted OAuth grants, and rate limits.
- **Development Inspector:** a local, authenticated Inspector UI and a repeatable deployed acceptance command.

## Connect your assistant

This is a **remote HTTP service**, not a stdio server or an `npx` desktop package. First deploy it or obtain a connector configuration from your service administrator.

1. Ask the administrator to create your organization and invite your email address.
2. Configure the remote connector with the administrator's private client configuration.
3. Start the connection in your MCP client and choose **Continue with Google**.
4. Sign in using the invited account. An organization administrator supplies the SAM.gov key on the consent page, then authorizes the connection.
5. Search using posted dates. Members can use the stored organization key without seeing it.

Get the **SAM.gov personal API key** from your SAM.gov Account Details. Do not assume a general api.data.gov key works for this API. Never place the SAM.gov key in a prompt, MCP tool arguments, connector URL, or Inspector headers.

### Gemini Enterprise

The initial operator command creates a confidential client with Google's documented callback:

| Setting              | Value                                                    |
| -------------------- | -------------------------------------------------------- |
| MCP URL              | `https://your-service.example/mcp`                       |
| Authorization URL    | `https://your-service.example/oauth/authorize`           |
| Token URL            | `https://your-service.example/oauth/token`               |
| Redirect URI         | `https://vertexaisearch.cloud.google.com/oauth-redirect` |
| Scopes               | `openid offline_access sam:opportunities:read`           |
| PKCE                 | Required, S256                                           |
| Client ID and secret | From the operator-generated private file                 |

Follow Google's [custom MCP connector setup](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server), including its domain allowlist. Successful Inspector tests do not establish Gemini compatibility. Other clients need their own registered callback; dynamic client registration is disabled.

## Tool reference

One read-only tool: **`get_sam_opportunities`**.

```json
{
  "posted_from": "10/01/2026",
  "posted_to": "10/08/2026",
  "keyword": "software",
  "naics": "541512",
  "limit": 10,
  "offset": 0
}
```

Use current dates for a live search. `keyword` searches **titles only**, not descriptions or attachments.

| Inputs                                        | Rules                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `posted_from`, `posted_to`                    | Required `MM/dd/yyyy`; ordered, at most one year apart                                         |
| `keyword`, `notice_id`, `solicitation_number` | Optional text filters                                                                          |
| `organization_name`, `organization_code`      | Optional agency/organization filters                                                           |
| `procurement_type`, `set_aside`               | SAM.gov codes; see [API documentation](https://open.gsa.gov/api/get-opportunities-public-api/) |
| `state`, `naics`, `classification_code`       | Optional place-of-performance state, NAICS, and classification filters                         |
| `limit`                                       | 1–100; default 10                                                                              |
| `offset`                                      | Zero-based **page index**, default 0; use returned `next_offset`                               |

Results include `total`, `opportunities`, `date_range`, `retrieved_at`, and `next_offset`. Only selected public fields and safe notice links are returned. Descriptions, attachments, entities, exclusions, and historical notice versions are outside this server's scope. Notice text is untrusted data, never instructions.

Upstream errors are explicit MCP tool errors (`isError: true`), not empty success results. Saving a key does not validate it. See [troubleshooting](./docs/operations.md#troubleshooting).

## Self-hosting

Requires Node.js **24 LTS**, PostgreSQL **17 or 18**, and a public HTTPS origin. Railway is the initial deployment target. All organizations in one deployment must use the same database and persistent encryption/signing configuration.

```sh
git clone https://github.com/blen-labs/samgov-mcp-server.git
cd samgov-mcp-server
npm ci
npm run build
node scripts/init-env.mjs https://your-service.example .env
```

The last command creates a **new private file** containing generated secrets; it never prints their values. Set `DATABASE_URL` and Google OAuth credentials privately, then follow the [Railway deployment guide](./docs/railway.md). `.env` is ignored and is not loaded automatically; local operator commands use Node's `--env-file` flag.

Google's authorized redirect URI must be:

```text
https://your-service.example/account/auth/callback/google
```

Create the first organization using the service's environment:

```sh
mkdir -p .local
node --env-file=.env dist/manage.js create-tenant 'Example Organization' admin@example.com .local/new-connector.json
```

Deliver that connector file privately to its administrator. It contains a client secret. Tenant UUIDs are returned in that file. Additional invitations, access revocation, key rotation, backups, and the optional external JWT mode are covered in [operations](./docs/operations.md).

## Development and testing

```sh
npm ci
npm run check       # formatting, lint, typecheck, unit tests, build
npm run verify      # complete suite in Docker with isolated PostgreSQL; no skipped DB tests
npm run inspector   # after provisioning a separate development client
npm run test:deployed # uses the Inspector's saved OAuth grant; requires real SAM.gov access
```

`npm run check` does not prove database or external-service behavior. `npm run verify` uses simulated SAM.gov responses and Google identity fixtures. `npm run test:deployed` requires a real browser login and checks discovery, invalid input, live search, distinct pagination, and notice lookup; it exits nonzero when acceptance is incomplete.

Inspector setup and examples: [development guide](./docs/development.md). Architecture and trust boundaries: [architecture](./docs/architecture.md). Findings and verification limits: [review record](./docs/verification.md).

## Releases and deployment

Following [FedReg's release pattern](https://github.com/blen-labs/fedreg-mcp-server), every merge to `main` creates a SemVer release: breaking changes bump major, `feat` bumps minor, other conventional commits bump patch. The initial release uses the version in `package.json`.

CI runs before version stamping, an annotated `vX.Y.Z` tag, GitHub release notes, and a versioned container image. Release recovery and optional Railway deployment are documented in [releasing](./docs/releases.md). No npm publishing is configured: this project ships a hosted service container and source releases.

## Security and contributing

See [SECURITY.md](./SECURITY.md) for the threat model and private vulnerability reporting. API keys and OAuth token payloads are encrypted, but the service operator still controls the database and encryption keys; this is not protection against a compromised host administrator.

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md). Do not include real credentials, `.local/` contents, production database dumps, or OAuth callback URLs with authorization codes in issues or pull requests.

## License

[Apache-2.0](./LICENSE) © 2026 BLEN, Inc. See [NOTICE](./NOTICE).

Built by [BLEN, Inc.](https://www.blencorp.com). Thanks to GSA for SAM.gov, the MCP team, Better Auth, and the maintainers of oidc-provider.
