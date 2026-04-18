# Cloudflare: DNS zone, DNS records, Pages custom-domain attachments.

data "cloudflare_zone" "primary" {
  name = var.domain
}

# R2 buckets (scani-tfstate for Terraform state, scani-backups for pg_dump
# archives) were created manually during bootstrap and are intentionally
# NOT managed by Terraform — state lives in one of them, so TF managing
# the bucket is a chicken-and-egg trap.
#
# Cloudflare Pages projects (scani-frontend, scani-landing) are created
# via the CF API on first bootstrap; subsequent deploys are driven by
# `wrangler pages deploy` from CI.

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

# scani-admin's pages-domain binding is managed by the deploy-admin CI job
# because the project itself is bootstrapped by `wrangler pages project create`
# in the same job — Terraform runs first and would see "Project not found".

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
