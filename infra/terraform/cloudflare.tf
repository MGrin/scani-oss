# Cloudflare: DNS zone, DNS records, Pages custom-domain attachments.

data "cloudflare_zone" "primary" {
  name = var.domain
}

# R2 buckets for Terraform state (scani-tfstate) and pg_dump archives
# (scani-backups) were created manually during bootstrap and are
# intentionally NOT managed by Terraform — TF state lives in one of them,
# so managing the bucket from TF is a chicken-and-egg trap.
#
# The job-upload bucket is new and unrelated to TF state, so TF owns it.
# Lifecycle rules (24h purge on `temp/*`) and CORS policies are not yet
# exposed by the cloudflare v4 provider — lifecycle is set via
# `wrangler r2 bucket lifecycle` and CORS lives at
# `infra/r2/scani-job-uploads-cors.json`, applied by the Apply job in
# .github/workflows/terraform.yaml after `terraform apply`. The JSON is
# the source of truth; manual `wrangler cors set` runs drift from it.
resource "cloudflare_r2_bucket" "job_uploads" {
  account_id = var.cloudflare_account_id
  name       = "scani-job-uploads"
  # APAC hint matches the Fly + Upstash + Neon ap-southeast-1 region.
  # Valid values (v4 provider) are uppercase: WNAM, ENAM, WEUR, EEUR, APAC, OC.
  location = "APAC"
}

# Cloudflare Pages projects — all three are Terraform-managed as of the
# stability/observability PR (2026-04-19). Project deploys (artifact uploads)
# still run from CI via `wrangler pages deploy`, but the project config +
# build env vars are owned by TF. scani-frontend and scani-landing existed
# before TF took over — see the `import` blocks at the bottom of this file
# for the bootstrap step; blocks can be removed after the first successful
# `terraform apply`.

# ---------- DNS records ----------

# Backend API: grey-cloud (DNS-only). Orange-cloud proxy has a 100s
# request timeout + inconsistent WebSocket behavior; Fly terminates TLS.
resource "cloudflare_record" "api" {
  zone_id = data.cloudflare_zone.primary.id
  name    = "api"
  content = "scani-backend.fly.dev"
  type    = "CNAME"
  proxied = false
  ttl     = 1 # auto
}

# api.cloud.scani.xyz → scani-data-provider.fly.dev. Browsers on
# cloud.scani.xyz call `/trpc` + `/api/auth/*` against this origin.
# DNS-only (not proxied) so Fly terminates TLS itself via the matching
# `fly_cert` resource; proxying through Cloudflare would require
# re-issuing origin certs and adds an extra TLS hop for no benefit.
resource "cloudflare_record" "api_cloud" {
  zone_id = data.cloudflare_zone.primary.id
  name    = "api.cloud"
  content = "scani-data-provider.fly.dev"
  type    = "CNAME"
  proxied = false
  ttl     = 1 # auto
  comment = "Fly.io backend. Grey-cloud."
}

# The app itself (React SPA) → scani-frontend Pages project.
resource "cloudflare_record" "app" {
  zone_id = data.cloudflare_zone.primary.id
  name    = "app"
  content = "scani-frontend.pages.dev"
  type    = "CNAME"
  proxied = true
  ttl     = 1
  comment = "Cloudflare Pages — scani-frontend"
}

# Internal admin dashboard → scani-admin Pages project. Not a public app —
# protected by passkey auth at the application layer, nothing else runs here.
# Cloud console (Tier 2 SaaS) → scani-cloud Pages project. Owns cloud API
# key management + usage dashboards for semi-managed deployments.
resource "cloudflare_record" "cloud" {
  zone_id = data.cloudflare_zone.primary.id
  name    = "cloud"
  content = "scani-cloud.pages.dev"
  type    = "CNAME"
  proxied = true
  ttl     = 1
  comment = "Cloudflare Pages — scani-cloud (tier-2 console)"
}

resource "cloudflare_record" "admin" {
  zone_id = data.cloudflare_zone.primary.id
  name    = "admin"
  content = "scani-admin.pages.dev"
  type    = "CNAME"
  proxied = true
  ttl     = 1
  comment = "Cloudflare Pages — scani-admin (passkey-gated)"
}

# Marketing / landing page (apex + www) → scani-landing Pages project.
# Split from the app to keep build pipelines and release cadences
# independent; landing can ship without reinstalling the app's 800-dep
# node_modules.
resource "cloudflare_record" "apex" {
  zone_id = data.cloudflare_zone.primary.id
  name    = "@"
  content = "scani-landing.pages.dev"
  type    = "CNAME"
  proxied = true
  ttl     = 1
  comment = "Cloudflare Pages — scani-landing (apex)"
}

resource "cloudflare_record" "www" {
  zone_id = data.cloudflare_zone.primary.id
  name    = "www"
  content = "scani-landing.pages.dev"
  type    = "CNAME"
  proxied = true
  ttl     = 1
  comment = "Cloudflare Pages — scani-landing (www)"
}

# ---------- Pages custom-domain attachments ----------
# Tell each Pages project which hostnames it owns. Without this, Pages
# returns a 404 "Domain not configured" even if the DNS resolves.

resource "cloudflare_pages_domain" "app" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.frontend.name
  domain       = local.app_host
}

# scani-admin Pages project. Created and owned by Terraform (unlike
# scani-frontend / scani-landing, which predate the TF setup). Compatibility
# settings here are the authoritative values; wrangler.toml is advisory only.
resource "cloudflare_pages_project" "admin" {
  account_id        = var.cloudflare_account_id
  name              = "scani-admin"
  production_branch = "main"

  deployment_configs {
    preview {
      compatibility_date  = "2025-01-01"
      compatibility_flags = ["nodejs_compat"]
    }
    production {
      compatibility_date  = "2025-01-01"
      compatibility_flags = ["nodejs_compat"]
    }
  }
}

resource "cloudflare_pages_domain" "admin" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.admin.name
  domain       = local.admin_host
}

# scani-cloud Pages project. Hosts cloud-frontend SPA at cloud.scani.xyz
# for Tier 2 semi-managed customers to manage their Cloud API keys +
# monitor per-request usage. Static build only — all dynamic calls go to
# the data-provider (api.scani.xyz/trpc + /api/auth/*) with cookies.
resource "cloudflare_pages_project" "cloud" {
  account_id        = var.cloudflare_account_id
  name              = "scani-cloud"
  production_branch = "main"

  deployment_configs {
    preview {
      compatibility_date  = "2025-01-01"
      compatibility_flags = ["nodejs_compat"]
    }
    production {
      compatibility_date  = "2025-01-01"
      compatibility_flags = ["nodejs_compat"]
    }
  }
}

resource "cloudflare_pages_domain" "cloud" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.cloud.name
  domain       = local.cloud_host
}

resource "cloudflare_pages_domain" "landing_apex" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.landing.name
  domain       = local.landing_host
}

resource "cloudflare_pages_domain" "landing_www" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.landing.name
  domain       = "www.${var.domain}"
}

# ---------------------------------------------------------------------------
# scani-frontend + scani-landing Pages projects, imported into TF.
# Both pre-date the TF setup. The `import` blocks bootstrap existing prod
# state; after the first `terraform apply`, TF owns their config. Keep the
# resource bodies minimal so `terraform plan` produces no drift against the
# current production configuration — only the fields TF must manage.
# ---------------------------------------------------------------------------

resource "cloudflare_pages_project" "frontend" {
  account_id        = var.cloudflare_account_id
  name              = "scani-frontend"
  production_branch = "main"
}

resource "cloudflare_pages_project" "landing" {
  account_id        = var.cloudflare_account_id
  name              = "scani-landing"
  production_branch = "main"
}

# TF 1.5+ `import` blocks — declarative equivalent of `terraform import`.
# Idempotent: after the first apply, TF considers the state "imported" and
# these blocks are no-ops on subsequent applies. Can be removed in a
# follow-up PR once the merge commit has deployed.
import {
  to = cloudflare_pages_project.frontend
  id = "${var.cloudflare_account_id}/scani-frontend"
}

import {
  to = cloudflare_pages_project.landing
  id = "${var.cloudflare_account_id}/scani-landing"
}
