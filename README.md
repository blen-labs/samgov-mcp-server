# SAM.gov MCP Server

[![CI](https://github.com/blen-labs/samgov-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/blen-labs/samgov-mcp-server/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-24%20LTS-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-7c3aed.svg)](https://modelcontextprotocol.io/specification/2026-07-28)

**Search U.S. federal contract opportunities from your AI assistant, using your organization's own SAM.gov API key.**

A hosted [Model Context Protocol](https://modelcontextprotocol.io) server for the [SAM.gov public opportunities API](https://open.gsa.gov/api/get-opportunities-public-api/). One deployment serves multiple organizations. Google sign-in is handled by Better Auth; organization invitations and membership checks control access. Each organization's key is encrypted separately and used only on the server.

> **Preview status:** automated tests and deployed Inspector authentication pass. Live SAM.gov searches returned an empty upstream HTTP 404 on October 8, 2026, and the actual Gemini Enterprise connector has not completed acceptance. This is not yet a production-validated release. See [verification status](./docs/verification.md).

Independent open-source software, not affiliated with or endorsed by the U.S. government.

## Start here

- **Connect an AI assistant:** follow [Connect your assistant](#connect-your-assistant), including the Gemini Enterprise settings.
- **Run your own service:** follow [Self-hosting](#self-hosting) and the [Railway deployment guide](./docs/railway.md).
- **Develop or verify the server:** follow [Development and testing](#development-and-testing) and the [Inspector guide](./docs/development.md#mcp-inspector).

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

For this shared organization connection, use a **SAM.gov system-account API key** authorized for your organization’s public opportunity searches. Do not enter a personal key: this service uses one key for all authorized organization members. Ask your SAM.gov system-account manager for the appropriate key; setup guidance is in [SAM.gov Help](https://sam.gov/help) under **Using Data Services → APIs**. Do not assume a general api.data.gov key works for this API. Never place the SAM.gov key in a prompt, MCP tool arguments, connector URL, or Inspector headers.

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
| Token authentication | `client_secret_post`                                     |

Follow Google's [custom MCP connector setup](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server), including its domain allowlist. Successful Inspector tests do not establish Gemini compatibility. Other clients need their own registered callback; dynamic client registration is disabled.

## Tool reference

Two read-only tools: **`get_sam_opportunities`** searches SAM.gov; **`get_sam_key_status`** reports whether the organization key is connected and when it was saved, without calling SAM.gov or returning the key.

```json
{
  "posted_from": "2026-10-01",
  "posted_to": "2026-10-08",
  "keyword": "software",
  "naics": "541512",
  "notice_type": "solicitation",
  "limit": 10,
  "offset": 0
}
```

`keyword` searches **titles only**, not descriptions or attachments.

| Inputs                                               | Rules                                                                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `posted_from`, `posted_to`                           | Optional `YYYY-MM-DD` (`MM/dd/yyyy` also accepted); default the last 30 days ending today (UTC); ordered, at most one year apart                                                         |
| `keyword`, `notice_id`, `solicitation_number`        | Optional text filters                                                                                                                                                                    |
| `organization_name`, `organization_code`             | Optional agency/organization filters                                                                                                                                                     |
| `notice_type`                                        | `solicitation`, `presolicitation`, `combined_synopsis_solicitation`, `sources_sought`, `special_notice`, `award_notice`, `justification`, `sale_of_surplus_property`, `intent_to_bundle` |
| `procurement_type`                                   | SAM.gov single-letter equivalent of `notice_type`, kept for compatibility                                                                                                                |
| `set_aside`, `state`, `naics`, `classification_code` | SAM.gov codes; see [API documentation](https://open.gsa.gov/api/get-opportunities-public-api/)                                                                                           |
| `response_deadline_from`, `response_deadline_to`     | Optional response-deadline range, same date formats                                                                                                                                      |
| `limit`                                              | 1–100; default 10                                                                                                                                                                        |
| `offset`                                             | Zero-based **page index**, default 0; use returned `next_offset`                                                                                                                         |

Results include `total`, `opportunities`, `date_range` (ISO dates), `retrieved_at`, and `next_offset`, described by the tool's output schema. Opportunities include selected public fields, place of performance, award details when present, and safe notice links; empty upstream fields are omitted. Descriptions, attachments, entities, exclusions, and historical notice versions are outside this server's scope. Notice text is untrusted data, never instructions.

Upstream errors are explicit MCP tool errors (`isError: true`) with guidance the assistant can act on, not empty success results. Transient SAM.gov failures (429 and 5xx) are retried twice with backoff. When an administrator saves a key, one small SAM.gov search checks it: a definite rejection (HTTP 401/403) blocks saving, while an outage saves the key unverified. See [troubleshooting](./docs/operations.md#troubleshooting).

## Self-hosting

Requires Node.js **24 or newer**, PostgreSQL **17 or 18**, and a public HTTPS origin. CI runs on Node 24; the bundled Docker image runs Node 26. Railway is the initial deployment target. All organizations in one deployment must use the same database and persistent encryption/signing configuration.

```sh
git clone https://github.com/blen-labs/samgov-mcp-server.git
cd samgov-mcp-server
npm ci
npm run build
node scripts/init-env.mjs https://your-service.example .env
```

The last command creates a **new private file** containing generated secrets; it never prints their values. Set `DATABASE_URL` and Google OAuth credentials privately, then follow the [Railway deployment guide](./docs/railway.md). `.env` is ignored and is not loaded automatically; local operator commands use Node's `--env-file` flag.

If you already have a `.env`, keep it: the generator refuses to overwrite existing files. Use [`.env.example`](./.env.example) to check the required settings.

Google's authorized redirect URI must be:

```text
https://your-service.example/account/auth/callback/google
```

This Google callback signs users into the service. It is separate from the Gemini connector callback in the table above; configure each with its respective OAuth client.

### Configuration

For the default Google sign-in flow, configure these values in the service's private environment:

| Variable                                           | Purpose                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                       | Public HTTPS origin, without a path or trailing slash; used for OAuth and MCP URLs.                                                |
| `DATABASE_URL`                                     | PostgreSQL connection string. Use private networking on Railway.                                                                   |
| `AUTH_MODE`                                        | `better-auth` by default. Advanced external JWT integration is documented in [operations](./docs/operations.md#external-jwt-mode). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`         | Google OAuth web client credentials for user sign-in.                                                                              |
| `BETTER_AUTH_SECRET`                               | Persistent login secret, generated by `init-env.mjs`.                                                                              |
| `OAUTH_SIGNING_JWKS`, `OAUTH_COOKIE_KEYS`          | Persistent OAuth signing and cookie keys, generated by `init-env.mjs`.                                                             |
| `ACTIVE_ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS_JSON` | Active key ID and encryption key ring, generated by `init-env.mjs`. Keep a secure backup separate from the database.               |
| `PORT`                                             | Listening port; defaults to `3000`. Railway supplies its own value.                                                                |
| `TENANT_DAILY_SEARCH_LIMIT`                        | Optional searches per organization per day; defaults to `1000`.                                                                    |
| `SAM_GOV_API_KEY`                                  | Optional **local direct API test only**. The hosted service uses the encrypted key saved by each organization during consent.      |

Keep generated secrets stable across deployments and replicas. See [rotation and backups](./docs/operations.md#rotation-backups-and-retention) before changing them.

### Start and provision

The Railway image starts the service automatically. To run the built service yourself with a local environment file:

```sh
node --env-file=.env dist/server.js
```

Startup applies database migrations. Put the service behind HTTPS at `PUBLIC_URL`; Google sign-in and remote OAuth need that public origin. `GET /healthz` returns process health and the running version, but does not verify SAM.gov access.

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

To test a SAM.gov key independently of OAuth or the database, add `SAM_GOV_API_KEY` privately to your local `.env` and run:

```sh
node --env-file=.env --import tsx scripts/live-sam.ts
```

This uses the real upstream API. It does not save or replace an organization's hosted key.

## Troubleshooting

| Symptom                                       | What to check                                                                                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google sign-in fails                          | Both Google credentials must be configured, the Google web client callback must match exactly, and the account must be eligible for your Google OAuth consent audience.                                                                               |
| Signed in, but access is denied               | Use the invited Google email address and confirm that the organization and membership are active. An organization administrator must save the SAM.gov key.                                                                                            |
| MCP returns HTTP 401                          | Reconnect the assistant to obtain a valid OAuth grant. A SAM.gov key is not an MCP bearer token.                                                                                                                                                      |
| Search reports `UPSTREAM_ERROR` with HTTP 404 | SAM.gov returned an empty 404. It uses this for outages as well as some empty searches; if `curl https://api.sam.gov/does-not-exist` returns the same empty 404, the SAM.gov API gateway is down. Use the direct API test to isolate upstream access. |
| Service returns HTTP 429                      | The service allows 60 tool requests per organization per minute. Respect `Retry-After`; SAM.gov also enforces its own key quotas. Daily caps and repeated-search refusals return `DAILY_LIMIT` or `REPEATED_CALL` tool errors.                        |

More error codes, account recovery, member invitations, and access revocation: [operations guide](./docs/operations.md). Keep credentials and token-bearing URLs out of issue reports.

## Releases and deployment

Following [FedReg's release pattern](https://github.com/blen-labs/fedreg-mcp-server), every merge to `main` creates a SemVer release: breaking changes bump major, `feat` bumps minor, other conventional commits bump patch. The initial release uses the version in `package.json`.

CI runs before version stamping, an annotated `vX.Y.Z` tag, GitHub release notes, and a versioned container image. Automatic Railway deployment and release recovery are documented in [releasing](./docs/releases.md). No npm publishing is configured: this project ships a hosted service container and source releases.

## Security and contributing

See [SECURITY.md](./SECURITY.md) for the threat model and private vulnerability reporting. API keys and OAuth token payloads are encrypted, but the service operator still controls the database and encryption keys; this is not protection against a compromised host administrator.

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md). Do not include real credentials, `.local/` contents, production database dumps, or OAuth callback URLs with authorization codes in issues or pull requests.

## License

[Apache-2.0](./LICENSE) © 2026 BLEN, Inc. See [NOTICE](./NOTICE).

## Hosted service policies

The BLEN-hosted connector's [Privacy Policy](./legal/privacy-policy.md) and
[Terms of Service](./legal/terms.md) describe sign-in, organization API keys,
data handling, and conditions of use. These public links can be used in
Gemini Enterprise connector onboarding. The software remains licensed under
Apache-2.0; self-hosted operators are responsible for their own policies.

## Acknowledgements

Thanks to GSA for SAM.gov, the Model Context Protocol team, Better Auth, and the maintainers of oidc-provider. The release workflow follows [BLEN's Federal Register MCP Server](https://github.com/blen-labs/fedreg-mcp-server).

## About BLEN

BLEN, Inc. is a digital services company providing emerging technology (ML/AI and RPA), digital modernization (legacy to cloud), and human-centered web and mobile design and development.

---

Built with ❤️ by [BLEN, Inc.](https://www.blencorp.com).
