# Contributing

Open an issue for a substantial change before implementing it. Keep the server focused on read-only SAM.gov opportunities and preserve tenant isolation, invitation-based access, PKCE, and encrypted key storage.

## Setup

Use Node 24 LTS and Docker. Run `npm ci`, `npm run check`, and `npm run verify`. The full verifier creates its own disposable PostgreSQL; never run tests against production. See [development](./docs/development.md) for Inspector and live acceptance.

- Add regression tests for authentication, authorization, protocol, or upstream behavior changes.
- Use `npm run format` and keep lint/typecheck gates passing.
- Do not add raw upstream URLs, credentials, cookie values, production fixtures, database dumps, or `.local/` artifacts to Git.
- Keep public API changes, migrations, and compatibility limits explicit. Breaking changes need a migration note and a breaking Conventional Commit.
- Use Conventional Commits and land changes through a pull request. Releases and tags are automated; see [releasing](./docs/releases.md).

A passing mocked test suite is not evidence that SAM.gov or Gemini works live. Report skipped and external-service gates separately. Security issues go through [private reporting](./SECURITY.md), not public issues. Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
