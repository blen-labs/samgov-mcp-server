# Development and Inspector

## Local verification

```sh
npm ci
npm run check
npm run verify
```

The quick check runs formatting, Biome correctness/security lint, TypeScript for production and tests/scripts, unit/release tests, and a build. Its PostgreSQL unit test is skipped without `TEST_DATABASE_URL`. The complete verifier creates an isolated Docker network and PostgreSQL database, runs the full suite in Node 24, and removes its own containers afterward. Do not point tests or preview scripts at production databases.

To use an existing disposable test database, set `TEST_DATABASE_URL` privately and run `npm run test:all`. The GitHub matrix covers PostgreSQL 17 and 18. SAM.gov is mocked and Google callback tests use signed fixtures. Those tests verify local behavior, not actual external service availability.

`npm run format` applies the shared format. `npm run lint` and `npm run typecheck` are independent checks. Verification records under `.local/` include before/after fingerprints and fail if inputs change while the suite runs.

## Test a SAM.gov key directly

Set the optional `SAM_GOV_API_KEY` in your ignored local `.env` to the current personal API key from SAM.gov Account Details, then run:

```sh
node --env-file=.env --import tsx scripts/live-sam.ts
```

If the key is already set securely in the shell environment, use `npm run test:live-sam` instead. The npm command does not load `.env` automatically. Neither command requires the local server or database to be running.

This calls SAM.gov directly and requires nonempty search results, distinct pagination, and a matching notice-ID lookup. It saves a sanitized result in `.local/live-sam.json`. A pass verifies upstream access with that key; use the deployed acceptance test below to verify the full MCP connection.

The hosted server does **not** use `SAM_GOV_API_KEY` as a shared credential. Each organization's administrator enters its key during consent, and the service encrypts it in PostgreSQL. Setting the local test variable does not update BLEN's stored key.

## MCP Inspector

The official Inspector is pinned as a dev dependency and omitted from the runtime image. It binds to `127.0.0.1:6274` with API authentication enabled. It is not a public route on the hosted server.

Provision a separate public PKCE client using the service operator environment:

```sh
mkdir -p .local/inspector
node --env-file=.env dist/manage.js create-inspector-client TENANT_UUID .local/inspector/config.json
npm run inspector
```

For a remote deployment, run the management command in the service environment and transfer its output privately to `.local/inspector/config.json` on the developer's machine. Do not copy production database credentials into a developer environment just to run the Inspector.

Open `http://127.0.0.1:6274` in the app browser. Connect `samgov-production`, sign in with an invited Google account, and approve the named Development Inspector connection. The registered callbacks are loopback ports 6274 (UI) and 6276 (CLI); the development client is separate from Gemini's confidential client.

OAuth state lives in ignored `.local/inspector/`. Secret values are encrypted using its private `storage.key` file. Keep the entire directory private; anyone with both the key and ciphertext can read the tokens. The launcher suppresses the Inspector's token-bearing web startup log. Stop it with Ctrl+C.

After browser authorization:

```sh
npm run inspector:cli -- --method tools/list --format json
npm run inspector:cli -- --protocol-era legacy --method tools/list --format json
npm run inspector:cli -- --method tools/call --tool-name get_sam_opportunities --tool-args-json '{"posted_from":"2026-10-01","posted_to":"2026-10-08","limit":2}' --format json
npm run test:deployed
```

Use current dates. The acceptance runner defaults to the last seven UTC days; override with `SAM_TEST_POSTED_FROM` and `SAM_TEST_POSTED_TO` if needed. It verifies both protocol modes, rejects unauthenticated access and invalid dates, and requires nonempty results, a distinct second page, and a matching notice-ID lookup. Results go to `.local/inspector-acceptance.json`; failure exits nonzero. It never reads the SAM.gov key locally.

If the Inspector token expires, reconnect through the UI. CLI checks use stored authorization only and will not open an unexpected login flow. Never put the SAM.gov key in Inspector headers or tool inputs.
