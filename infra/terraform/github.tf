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
