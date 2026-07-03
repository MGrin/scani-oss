locals {
  app_host   = "app.${var.domain}"
  api_host   = "api.${var.domain}"
  admin_host = "admin.${var.domain}"
  cloud_host = "cloud.${var.domain}"
  # Data-provider's public origin — browsers on `cloud_host` hit this
  # subdomain for `/trpc` + `/api/auth/*`. Kept under `cloud.*` so it
  # reads as part of the cloud-management surface, and so future tenant-
  # scoped subdomains (e.g. `acme.cloud.scani.xyz`) can sit alongside it.
  api_cloud_host = "api.cloud.${var.domain}"
  landing_host   = var.domain
}

# Provider configs read tokens from environment variables; Terraform never
# sees them in source. See docs/technical/CLOUDFLARE_DNS_SETUP.md (and the
# Credentials section of the migration plan) for the full list.

provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN via env
}

provider "fly" {
  # FLY_API_TOKEN via env
}

provider "neon" {
  # NEON_API_KEY via env
}

provider "github" {
  owner = var.github_owner
  # GITHUB_TOKEN via env
}
