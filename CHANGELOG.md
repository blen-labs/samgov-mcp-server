# Changelog

Versions follow SemVer. Every non-release merge to main produces a release.
A version tag records software changes; it does not certify live SAM.gov or Gemini acceptance.

## [Unreleased]

## [0.1.3] - 2026-10-08

- docs: clarify setup and add BLEN signature

## [0.1.2] - 2026-10-08

- build(deps): bump node from 24-alpine to 26-alpine

## [0.1.1] - 2026-10-08

- docs: record successful hosted release and Railway deployment

## [0.1.0] - 2026-10-08

- ci: deploy each verified release tag to Railway production
- docs: expose optional SAM key for direct local API testing
- docs: document Apache-2.0 hosting and verification boundaries
- ci: add verified SemVer releases and tag-based Railway deployment
- fix: provision tenant OAuth clients within database transactions
- fix: harden request handling and upstream credential redaction
- feat: extract hosted multi-tenant SAM.gov MCP service
