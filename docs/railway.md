# Railway deployment

## First deployment

1. Create a Railway project with the app service and PostgreSQL on a private network. Use this repository's root Dockerfile and `railway.json`.
2. Assign the app a public HTTPS domain. Set `PUBLIC_URL` to that exact origin.
3. Generate persistent configuration using `node scripts/init-env.mjs https://YOUR_DOMAIN .env` on a trusted machine. Transfer its values into Railway Variables privately; do not upload `.env` with the source.
4. Set `DATABASE_URL` to Railway's private PostgreSQL reference, for example `${{Postgres.DATABASE_URL}}` when the database service is named `Postgres`. Leave database public networking disabled.
5. Create a Google OAuth **web** client with redirect URI `https://YOUR_DOMAIN/account/auth/callback/google`; set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Configure the consent audience and branding for your intended users. Testing-mode access is not broad production rollout approval.
6. Deploy. The image runs as a non-root user. Startup runs additive migrations; `/healthz` is the Railway health check. Verify startup before provisioning an organization.
7. Use Railway SSH or your operator console to run `node dist/manage.js create-tenant NAME ADMIN_EMAIL /tmp/new-connector.json`. Transfer the generated file privately, then remove the task-owned temporary copy. Do not print its secret in logs or chat.
8. Complete Google sign-in and real Inspector search acceptance. Separately test the real Gemini Enterprise connector.

The service must use persistent encryption, signing, Better Auth, and cookie secrets across restarts and replicas. Do not put SAM.gov keys in global Railway variables: users' keys belong in encrypted per-tenant database rows, entered during consent.

## Continuous delivery

`.github/workflows/deploy.yml` is a **manual, tag-based deployment**. Create a GitHub environment named `production`, with the repository's desired reviewers and deployment branch/tag rules, and configure:

| Environment value        | Kind                                   |
| ------------------------ | -------------------------------------- |
| `RAILWAY_PROJECT_TOKEN`  | Secret: a Railway project-scoped token |
| `RAILWAY_SERVICE_ID`     | Variable: app service ID               |
| `RAILWAY_ENVIRONMENT_ID` | Variable: Railway environment ID       |
| `DEPLOY_URL`             | Variable: public HTTPS origin          |

Choose a published `vX.Y.Z` in **Actions → Deploy Railway**. The workflow checks out that exact tag, reruns verification, deploys using the pinned CLI, and checks public health plus unauthenticated MCP rejection. Those checks do not prove Google, SAM.gov, or Gemini acceptance; run those separately before treating the release as ready for users.

Repository secrets and environment protection are not created by adding YAML. The initial open-source preparation does not configure GitHub or Railway account settings.

## Rollback

Record the currently accepted Railway deployment ID and Git tag before releasing. Roll back to that known deployment in Railway, or dispatch Deploy Railway with the previous published tag. Do not rotate secrets or replace the database during a code rollback. Database changes must remain backward compatible; verify a restore/rollback procedure in staging before introducing destructive migrations.

Disable overlapping Railway automatic branch deploys if the tag-based workflow is your chosen release path. Otherwise two independent deployment mechanisms can race.
