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

# ---------- Branch protection on `main` ----------
#
# Audit finding D-08 calls for a Terraform-managed `github_branch_protection`
# on `main` (CI required, code-owner reviews, no force-push, admins not
# exempt). The 2026-05-12 apply rejected this with `Resource not
# accessible by personal access token` — the `TF_GITHUB_TOKEN` PAT
# currently has the scopes needed to manage Actions secrets (`repo` +
# `workflow`) but NOT the `administration: write` scope needed to set
# branch-protection rules.
#
# Deferred until the PAT is rotated with the additional scope. Until
# then, branch protection lives in the GitHub UI (Settings → Branches).
# CODEOWNERS still enforces required-reviewer routing for PRs.
#
# resource "github_branch_protection" "main" {
#   repository_id                   = data.github_repository.scani.node_id
#   pattern                         = "main"
#   enforce_admins                  = true
#   require_signed_commits          = false
#   required_linear_history         = true
#   allows_force_pushes             = false
#   allows_deletions                = false
#   require_conversation_resolution = true
#
#   required_pull_request_reviews {
#     required_approving_review_count = 1
#     require_code_owner_reviews      = true
#     dismiss_stale_reviews           = true
#   }
#
#   required_status_checks {
#     strict = true
#     contexts = [
#       "Lint & Type Check",
#       "Deps sync & knip",
#       "Test",
#       "Secret scan",
#     ]
#   }
# }

resource "github_actions_secret" "database_url_direct" {
  repository      = data.github_repository.scani.name
  secret_name     = "DATABASE_URL_DIRECT"
  plaintext_value = neon_project.scani.connection_uri
}

# Password for the self-hosted Redis that runs inside the scani-worker
# machine (see apps/backend/worker/docker-entrypoint.sh — it parses this
# out of REDIS_URL to set `requirepass`). Generated once by TF so the
# value is stable across applies; rotate via the keepers convention
# below (same as admin_jobs_hmac_secret), then redeploy all three
# backend apps so producer + consumer agree on the password.
resource "random_password" "redis_password" {
  length  = 48
  special = false
  keepers = {
    rotation_id = "2026-07-03"
  }
}

# BullMQ + rate-limiter + realtime pub/sub Redis. Points at the
# redis-server embedded in the scani-worker machine over Fly 6PN private
# networking — replaced the metered Upstash database (2026-07 cost
# reduction: idle BullMQ polling alone billed ~$40/mo on per-command
# pricing). The Upstash database in upstash.tf stays for the admin app's
# REST-only needs (spend overrides, audit log, page cache).
resource "github_actions_secret" "redis_url" {
  repository      = data.github_repository.scani.name
  secret_name     = "REDIS_URL"
  plaintext_value = "redis://default:${random_password.redis_password.result}@scani-worker.internal:6379"
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
  # Bump `rotation_id` to force regeneration on the next
  # `terraform apply`. Convention: `<YYYY-MM-DD>` of the rotation,
  # so the file diff itself documents when (and roughly why) the
  # last rotation happened. Suggested cadence: every 90 days, or
  # immediately on suspected secret compromise. Pair the bump with
  # a redeploy of `scani-backend` and `scani-admin` so both sides
  # pick up the new value within seconds; until both have, signed
  # admin requests fail with `signature mismatch`.
  keepers = {
    rotation_id = "2026-05-12"
  }
}

resource "github_actions_secret" "admin_jobs_hmac_secret" {
  repository      = data.github_repository.scani.name
  secret_name     = "JOBS_HMAC_SECRET"
  plaintext_value = random_password.admin_jobs_hmac_secret.result
}

# Pepper for one-way hashing of user/tenant/account IDs in structured
# logs. The pseudonymize helper in @scani/logging refuses to import
# under NODE_ENV=production without this — without it, raw UUIDs would
# leak to the shared Sentry / pino aggregator. Generated once by TF so
# the value is stable across redeploys (rotation deliberately requires
# `terraform taint` + apply to avoid accidentally breaking log-trail
# joins). 64 chars satisfies the runtime min-length check with margin.
# Consumed by: scani-backend, scani-worker, scani-data-provider — all
# three import @scani/logging and run with NODE_ENV=production.
resource "random_password" "log_id_pepper" {
  length  = 64
  special = false
  # Rotation breaks the cross-service hash join (same user shows up as
  # a different pseudonym before vs after rotation). Bump only when
  # there's a real reason — suspected pepper exposure, an annual
  # compliance review, etc. Document the bump rationale in the commit
  # message so the audit trail explains the discontinuity.
  keepers = {
    rotation_id = "2026-05-12"
  }
}

resource "github_actions_secret" "log_id_pepper" {
  repository      = data.github_repository.scani.name
  secret_name     = "LOG_ID_PEPPER"
  plaintext_value = random_password.log_id_pepper.result
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
  # Same convention as admin_jobs_hmac_secret: bump rotation_id to
  # roll. Affects data-provider (server-side validator) AND
  # backend + worker (caller). Stage backend/worker redeploys
  # alongside the rotation so they pick up the new key from secrets
  # in the same window.
  keepers = {
    rotation_id = "2026-05-12"
  }
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
  # Rotating this invalidates every active cloud-frontend session
  # immediately. Don't bump casually — schedule with users (notify
  # via banner), then bump + redeploy data-provider.
  keepers = {
    rotation_id = "2026-05-12"
  }
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

# -----------------------------------------------------------------------
# PostHog analytics secrets.
#
# POSTHOG_KEY / VITE_POSTHOG_KEY mirror the public project key (phc_...)
# so the deploy workflow bakes it into the SPA bundles and stages it onto
# the Fly apps — same fan-out pattern as the Sentry DSNs above.
#
# EMAIL_TRACKING_SECRET is the HMAC key that signs email open/click
# tracking tokens; generated once by TF (stable across redeploys) and
# consumed by scani-backend + scani-data-provider. See posthog.tf for the
# dashboards/insights and .github/workflows/terraform.yaml for the
# provider credentials (the personal API key stays a hand-set secret,
# like SENTRY_AUTH_TOKEN).
# -----------------------------------------------------------------------

resource "github_actions_secret" "posthog_key" {
  repository      = data.github_repository.scani.name
  secret_name     = "POSTHOG_KEY"
  plaintext_value = var.posthog_project_key
}

resource "github_actions_secret" "vite_posthog_key" {
  repository      = data.github_repository.scani.name
  secret_name     = "VITE_POSTHOG_KEY"
  plaintext_value = var.posthog_project_key
}

resource "random_password" "email_tracking_secret" {
  length  = 48
  special = false
  # Rotating invalidates in-flight tracking links in already-sent
  # emails (their tokens stop verifying — opens/clicks just go
  # uncounted, mail still delivers fine). Bump rotation_id + redeploy
  # scani-backend and scani-data-provider together.
  keepers = {
    rotation_id = "2026-05-18"
  }
}

resource "github_actions_secret" "email_tracking_secret" {
  repository      = data.github_repository.scani.name
  secret_name     = "EMAIL_TRACKING_SECRET"
  plaintext_value = random_password.email_tracking_secret.result
}
