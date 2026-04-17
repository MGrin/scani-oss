# Cloudflare: DNS zone, Pages project, R2 state bucket, DNS records.

data "cloudflare_zone" "primary" {
  name = var.domain
}

# R2 buckets (scani-tfstate for Terraform state, scani-backups for pg_dump
# archives) were created manually during bootstrap and are intentionally
# NOT managed by Terraform — doing so would create a chicken-and-egg
# problem (state lives in the bucket that state would delete).

# Cloudflare Pages (scani-frontend) is created manually in the Cloudflare
# dashboard. The account-scoped API token provided does not carry
# Pages:Edit permission, and creating the Pages project is a one-time
# click-through ("Connect a repository" → MGrin/scani → main branch, build
# command `cd apps/frontendV2 && bun install && bun run build`, output
# `apps/frontendV2/dist`). Once created, DNS records below route
# app.scani.xyz and scani.xyz to `scani-frontend.pages.dev` in Phase 5.
#
# Pages custom-domain attachment is deferred to Phase 5; see DNS block
# below for the actual cutover records.

# Backend: grey-cloud (DNS-only). Orange-cloud proxy has a 100s timeout +
# inconsistent WS behavior; Fly terminates TLS itself.
resource "cloudflare_record" "api" {
  zone_id = data.cloudflare_zone.primary.id
  name    = "api"
  content = "scani-backend.fly.dev"
  type    = "CNAME"
  proxied = false
  ttl     = 1 # auto
  comment = "Fly.io backend. Grey-cloud."
}

# ----------------------------------------------------------------------------
# PHASE 5 CUTOVER RECORDS
# ----------------------------------------------------------------------------
# app.scani.xyz currently CNAMEs to scani-frontend.onrender.com (Render).
# Flip `attach_pages_domains` to true to: (a) attach the custom domain to
# Cloudflare Pages, and (b) replace the Render CNAME with a Pages CNAME.
# This is the DNS cutover: once applied, app.scani.xyz serves from Pages,
# not Render. Reversible in minutes: `terraform apply -var attach_pages_domains=false`
# restores the Render CNAME.

resource "cloudflare_pages_domain" "app" {
  count        = var.attach_pages_domains ? 1 : 0
  account_id   = var.cloudflare_account_id
  project_name = "scani-frontend"
  domain       = local.app_host
}

resource "cloudflare_pages_domain" "apex" {
  count        = var.attach_pages_domains ? 1 : 0
  account_id   = var.cloudflare_account_id
  project_name = "scani-frontend"
  domain       = local.landing_host
}

# DNS for app.scani.xyz: imports and manages the existing record. When
# attach_pages_domains=false, keeps pointing at Render. When true, swings
# to Pages.
resource "cloudflare_record" "app" {
  count   = var.attach_pages_domains ? 1 : 0
  zone_id = data.cloudflare_zone.primary.id
  name    = "app"
  content = "scani-frontend.pages.dev"
  type    = "CNAME"
  proxied = true # orange-cloud OK for static frontend; Pages handles TLS
  ttl     = 1
  comment = "Cloudflare Pages. Flip via attach_pages_domains."
}
