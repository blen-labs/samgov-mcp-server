# Review and verification record

Reviewed on October 8, 2026, for the initial open-source preview. This was an adversarial review by the implementing agent, with execution-backed regression tests. It was **not** an independent penetration test or a guarantee that no defects remain.

## Findings corrected

| Finding                                                                                                       | Correction and evidence                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed HTTP request targets could throw before asynchronous error handling                                 | Validate origin-form targets and catch synchronous dispatch exceptions; real HTTP tests confirm malformed targets and handler exceptions leave the server available.                                                                            |
| A reflected SAM.gov key could bypass redaction through notice IDs, numeric fields, or generated notice links  | Redact before synthesizing links; regression cases include reflected strings and numeric credentials.                                                                                                                                           |
| Upstream failures could leave response bodies unconsumed; contradictory result totals could appear successful | Cancel error bodies and reject inconsistent or oversized responses. Test network errors, status failures, malformed data, and size bounds.                                                                                                      |
| Leap-day date arithmetic could admit a range past its one-year anniversary                                    | Clamp the anniversary to the last valid day of the target month; boundary regression tests.                                                                                                                                                     |
| Organization/client provisioning could partially commit database records                                      | Save tenant binding, invitation, and encrypted OAuth client within a transaction; rollback test verifies that failed provisioning leaves no visible OAuth client. Production-image smoke testing exercises both operator provisioning commands. |
| Verification could describe files edited during a test run                                                    | Compare before/after source fingerprints and fail on changes; use isolated test containers and unique image tags.                                                                                                                               |
| Live acceptance could pass without testing pagination                                                         | Require a nonempty distinct second page and exact notice lookup; upstream failure remains a failed acceptance result.                                                                                                                           |
| Deployment checks could accept an older healthy release                                                       | Include the runtime version in health responses and require the selected package version after deployment.                                                                                                                                      |

## Executed local checks

- Formatting, Biome lint, TypeScript checks for production/test/script code, and production build.
- Full Docker acceptance on Node 24 with **PostgreSQL 17 and PostgreSQL 18: 26 tests passed per database, zero skipped** (23 TypeScript tests and three release/configuration tests).
- Tests exercise confidential and Inspector public-PKCE OAuth flows, consent and encrypted key entry, token refresh, replay rejection, revocation across instances, cross-tenant denial, persistence, verified Google identity fixtures, password recovery, modern/legacy MCP, and upstream failure handling.
- Release tests exercise a disposable Git repository: initial release, dirty-tree rejection, no-op rerun, synchronized versions, docs-only patch release, malformed inputs, and recovery restricted to the exact existing tag.
- Configuration tests verify private file permissions, refusal to overwrite files, rejected unsafe origins, and suppressed generated secrets.
- Production container construction and startup/restart smoke checks: migrations, private operator provisioning, health version, protected MCP rejection, discovery, non-root execution, and absence of Inspector/TypeScript/tsx from the runtime image.
- Actionlint validates all GitHub workflow files. Credential scans and dependency advisory checks are run before the final local commits.

Local evidence and source fingerprints are saved under ignored `.local/` paths. They are not distributed because that directory also contains private operational artifacts. Reproduce the software checks with:

```sh
npm ci
npm run check
npm run verify
TEST_POSTGRES_VERSION=18 npm run verify
npm run check:public
npm audit --omit=dev --audit-level=high
```

`npm run check` alone skips the database-dependent unit test when no disposable database is configured. Only the full verifier or `test:all` with a disposable database satisfies the complete automated suite. Tests do not use production data.

## External acceptance remains incomplete

| Gate                                             | Observed status                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployed Inspector authentication                | Earlier deployed flow completed Google sign-in, tenant consent, and modern/legacy discovery. This does not validate every subsequent local review change in production.                                                                                                                                                             |
| Actual SAM.gov search                            | Earlier live calls returned an empty HTTP 404 directly and through the deployed MCP. Search, pagination, and notice lookup have **not passed** live acceptance. Current SAM.gov account-key comparison is pending.                                                                                                                  |
| Actual Gemini Enterprise connector               | Not acceptance-tested. Inspector compatibility is not proof of Gemini compatibility.                                                                                                                                                                                                                                                |
| GitHub Actions, GitHub release, GHCR publication | The public repository and annotated `v0.1.0` release were published. [Release run 37800288732](https://github.com/blen-labs/samgov-mcp-server/actions/runs/37800288732) passed both database matrices, image checks, credential scanning, release validation, and container publication. The GHCR package is intentionally private. |
| Railway release workflow                         | The same hosted release run deployed `v0.1.0` to production and passed version-matching health plus unauthenticated MCP rejection. A production-scoped Railway token is stored in the GitHub `production` environment.                                                                                                              |
| Production readiness                             | Load/edge limits, backup restoration, and destructive migration/rollback drills remain outstanding.                                                                                                                                                                                                                                 |

The service stays a **preview** until real SAM.gov access and the intended client pass. Use [development acceptance](./development.md) for the live test, [operations](./operations.md) for resource/retention limits, and [release setup](./releases.md) for account-level gates. An upstream 404 is neither a successful empty search nor proof that a key is invalid.
