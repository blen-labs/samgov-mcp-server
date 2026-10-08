# Releases

The release policy follows FedReg: every non-release merge to `main` is released. Use Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, and other allowed types). A breaking `!` or `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer bumps major; a feature bumps minor; everything else bumps patch. The first release uses the existing `package.json` version without requiring a preexisting tag.

## Pipeline

1. CI checks formatting, lint, production/test type checking, all tests on PostgreSQL 17 and 18, production image construction, public-file boundaries, known runtime advisories, commit subjects, and redacted Git-history credential scanning.
2. The release job requires the current `main` tip. It stamps `package.json`, the lockfile root versions, `src/version.ts`, and the changelog together. It reruns local and container checks on those exact files.
3. It creates a release commit, builds the versioned non-root runtime image, and atomically pushes that commit and its annotated `vX.Y.Z` tag. Concurrent changes to `main` cause the push to fail instead of overwriting another commit. A subsequent run can include both changes.
4. It publishes `ghcr.io/blen-labs/samgov-mcp-server:X.Y.Z` and a GitHub release. Versions below 1.0 are marked GitHub prereleases. No floating `latest` image tag or npm package is published.

Release commits use `GITHUB_TOKEN`, so they do not trigger another workflow run. The workflow also skips `chore(release):` pushes. No personal access token or npm publishing secret is required. Repository rules must permit the narrowly scoped release automation to push its version commit and tag; do not broadly disable branch protections. Confirm Actions write/package permissions before enabling releases.

A software release records source changes. It does **not** certify upstream SAM.gov availability, Gemini compatibility, backup restoration, or production load capacity. The README and verification record retain those limits.

## Partial-failure recovery

If the commit and tag were pushed but image or GitHub release publication failed, dispatch **Release** with `recover_tag=vX.Y.Z`. Recovery checks out that existing tag, extracts its changelog notes, reruns verification, and republishes that version without another bump or Git tag. A mismatched tag/version is rejected.

Container tags are registry references, not an immutability guarantee; recovery may rebuild a tag. Pin the image digest for deployments requiring immutable image identity. Git version tags must never be moved or reused. The production Node base image is pinned by digest; Dependabot proposes reviewed updates.

The preparation script only edits a clean checkout; it never commits, tags, or pushes by itself. Test it in a disposable clone, not your working branch. Its tests cover bootstrap, no-op reruns, dirty-tree rejection, version synchronization, docs-only increments, and malformed inputs.

## Repository setup before first publication

- Enable private vulnerability reporting and dependency/security alerts.
- Require PR review and the CI checks appropriate to the repository ruleset.
- Configure minimal Actions contents/package write access for the release job.
- Review initial package visibility in GHCR; a public repository does not automatically make every package public.
- Configure the `production` environment only when enabling the optional Railway workflow.
- Verify the first hosted Actions run, release, image publication, and optional deployment. Local tests cannot prove account permissions or remote workflow execution.
