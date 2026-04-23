# GitHub Actions secrets — fan out from Terraform-managed values so the
# deploy workflow can pick them up without the user manually pasting them
# into the GitHub Secrets UI.
#
# Note: the `production` environment + required-reviewer approval gate is
# NOT managed here because the fine-grained PAT would need Environments
# admin scope, which conflicts with "this repo only" scoping. Create the
# environment once in the GitHub UI; repo secrets below are sufficient
# for the deploy workflow.

data "github_repository" "scani" {
  full_name = "${var.github_owner}/${var.github_repo}"
}

resource "github_actions_secret" "database_url_direct" {
  repository      = data.github_repository.scani.name
  secret_name     = "DATABASE_URL_DIRECT"
  plaintext_value = neon_project.scani.connection_uri
}

resource "github_actions_secret" "redis_url" {
  repository      = data.github_repository.scani.name
  secret_name     = "REDIS_URL"
  plaintext_value = "rediss://default:${upstash_redis_database.scani.password}@${upstash_redis_database.scani.endpoint}:${upstash_redis_database.scani.port}"
}

resource "github_actions_secret" "fly_api_token" {
  repository      = data.github_repository.scani.name
  secret_name     = "FLY_API_TOKEN"
  plaintext_value = var.fly_api_token
}

# HMAC secret shared between the backend (verifies signed /admin/jobs/*
# requests) and the admin Pages app (signs them). Generated once by TF so
# the value is stable across redeploys; consumed by:
#   - backend Fly secrets (pushed by deploy-fly.yaml before flyctl deploy)
#   - admin Cloudflare Pages secrets (pushed by deploy-fly.yaml sync loop)
# Rotate by tainting `random_password.admin_jobs_hmac_secret` + re-apply;
# both sides pick up the new value on their next deploy.
resource "random_password" "admin_jobs_hmac_secret" {
  length  = 64
  special = false
}

resource "github_actions_secret" "admin_jobs_hmac_secret" {
  repository      = data.github_repository.scani.name
  secret_name     = "ADMIN_JOBS_HMAC_SECRET"
  plaintext_value = random_password.admin_jobs_hmac_secret.result
}

# R2 bucket name for temp job-payload storage (screenshot parsing, file
# imports). Value is the Terraform-managed bucket above, mirrored into
# GH Secrets so the deploy workflow can stage it onto Fly and Pages.
resource "github_actions_secret" "r2_bucket" {
  repository      = data.github_repository.scani.name
  secret_name     = "R2_BUCKET"
  plaintext_value = cloudflare_r2_bucket.job_uploads.name
}

# R2 account ID — same value as CLOUDFLARE_ACCOUNT_ID, but mirrored under
# the R2_ prefix so the backend/worker env loaders (which read R2_*
# explicitly) don't have to special-case the shared Cloudflare var.
resource "github_actions_secret" "r2_account_id" {
  repository      = data.github_repository.scani.name
  secret_name     = "R2_ACCOUNT_ID"
  plaintext_value = var.cloudflare_account_id
}

# -----------------------------------------------------------------------
# Sentry secrets — DSN per app plus the shared auth token used by CI for
# sourcemap uploads. The deploy workflow stages these onto Fly secrets
# (backend/worker) or passes them as Vite/Next build env (frontend/admin/
# landing). See sentry.tf for project provisioning.
# -----------------------------------------------------------------------

resource "github_actions_secret" "sentry_dsn_backend" {
  repository      = data.github_repository.scani.name
  secret_name     = "SENTRY_DSN_BACKEND"
  plaintext_value = data.sentry_key.backend.dsn.public
}

resource "github_actions_secret" "sentry_dsn_worker" {
  repository      = data.github_repository.scani.name
  secret_name     = "SENTRY_DSN_WORKER"
  plaintext_value = data.sentry_key.worker.dsn.public
}

resource "github_actions_secret" "sentry_dsn_data_provider" {
  repository      = data.github_repository.scani.name
  secret_name     = "SENTRY_DSN_DATA_PROVIDER"
  plaintext_value = data.sentry_key.data_provider.dsn.public
}

# Tenant-shared API key the data-provider validates and that the backend +
# worker present as `Authorization: Bearer` to the data-provider. Generated
# once by TF; the same value lands as DATA_PROVIDER_API_KEY on the data-
# provider Fly app and as SCANI_CLOUD_API_KEY on backend + worker. Rotate
# by tainting `random_password.scani_cloud_api_key` and re-running
# terraform apply, then redeploying all three services.
resource "random_password" "scani_cloud_api_key" {
  length  = 48
  special = false
}

resource "github_actions_secret" "data_provider_api_key" {
  repository      = data.github_repository.scani.name
  secret_name     = "DATA_PROVIDER_API_KEY"
  plaintext_value = random_password.scani_cloud_api_key.result
}

# The deploy-fly workflow used to consume two separate secrets here —
# SCANI_CLOUD_API_KEY (backend+worker bearer) and SCANI_CLOUD_URL
# (backend+worker base URL). Both are gone now: the API key is sourced
# from DATA_PROVIDER_API_KEY directly (one secret to manage instead of a
# mirror pair), and the URL is hardcoded to https://api.cloud.scani.xyz
# in the workflow since it's a public hostname owned by terraform's
# `cloudflare_record.api_cloud`.

# Signing secret for Better-Auth cookie sessions on cloud.scani.xyz (Tier 2
# console). Generated once by TF; rotating invalidates every existing
# session, so coordinate with users before tainting.
resource "random_password" "cloud_better_auth_secret" {
  length  = 48
  special = false
}

resource "github_actions_secret" "cloud_better_auth_secret" {
  repository      = data.github_repository.scani.name
  secret_name     = "CLOUD_BETTER_AUTH_SECRET"
  plaintext_value = random_password.cloud_better_auth_secret.result
}

# DATABASE_URL for the data-provider's cloud_* tables (cloud_users,
# cloud_api_keys + Better-Auth session tables + cloud_usage_events). Same
# Neon project as the backend; per-request usage rows live in
# `cloud_usage_events` in this database.
resource "github_actions_secret" "database_url" {
  repository      = data.github_repository.scani.name
  secret_name     = "DATABASE_URL"
  plaintext_value = neon_project.scani.connection_uri_pooler
}

resource "github_actions_secret" "sentry_dsn_frontend" {
  repository      = data.github_repository.scani.name
  secret_name     = "VITE_SENTRY_DSN_FRONTEND"
  plaintext_value = data.sentry_key.frontend.dsn.public
}

resource "github_actions_secret" "sentry_dsn_admin" {
  repository      = data.github_repository.scani.name
  secret_name     = "NEXT_PUBLIC_SENTRY_DSN_ADMIN"
  plaintext_value = data.sentry_key.admin.dsn.public
}

resource "github_actions_secret" "sentry_dsn_landing" {
  repository      = data.github_repository.scani.name
  secret_name     = "VITE_SENTRY_DSN_LANDING"
  plaintext_value = data.sentry_key.landing.dsn.public
}

resource "github_actions_secret" "sentry_auth_token" {
  repository      = data.github_repository.scani.name
  secret_name     = "SENTRY_AUTH_TOKEN"
  plaintext_value = var.sentry_auth_token
}

resource "github_actions_secret" "sentry_org" {
  repository      = data.github_repository.scani.name
  secret_name     = "SENTRY_ORG"
  plaintext_value = var.sentry_org
}
