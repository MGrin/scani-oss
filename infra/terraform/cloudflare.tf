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
# Lifecycle rules (24h purge on `temp/*`) are not yet exposed by the
# cloudflare v4 provider — set them via `wrangler r2 bucket lifecycle`
# or the Cloudflare API post-apply. The bucket is the source of truth
# here; an orphaned object just eats storage, not correctness.
resource "cloudflare_r2_bucket" "job_uploads" {
  account_id = var.cloudflare_account_id
  name       = "scani-job-uploads"
  # APAC hint matches the Fly + Upstash + Neon ap-southeast-1 region.
  # Valid values (v4 provider) are uppercase: WNAM, ENAM, WEUR, EEUR, APAC, OC.
  location = "APAC"
}

# Cloudflare Pages projects:
# - scani-frontend, scani-landing: created via the CF API on first bootstrap
#   (pre-date Terraform); subsequent deploys are driven by `wrangler pages
#   deploy` from CI. Their cloudflare_pages_domain bindings live below.
# - scani-admin: managed here (resource "cloudflare_pages_project" "admin"),
#   so both the project and its custom-domain binding live in Terraform.
#   CI polls until the project exists, then `wrangler pages deploy`s to it.

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
  project_name = "scani-frontend"
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

resource "cloudflare_pages_domain" "landing_apex" {
  account_id   = var.cloudflare_account_id
  project_name = "scani-landing"
  domain       = local.landing_host
}

resource "cloudflare_pages_domain" "landing_www" {
  account_id   = var.cloudflare_account_id
  project_name = "scani-landing"
  domain       = "www.${var.domain}"
}
