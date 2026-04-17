locals {
  app_host     = "app.${var.domain}"
  api_host     = "api.${var.domain}"
  landing_host = var.domain
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

provider "upstash" {
  email   = data.external.upstash_creds.result.email
  api_key = data.external.upstash_creds.result.api_key
}

# Upstash's Terraform provider wants email + API key as arguments rather
# than env vars. A small data source shells out to read them from the env
# without baking secrets into tfvars / state outside what the provider
# already stores.
data "external" "upstash_creds" {
  program = ["bash", "-c", "jq -n --arg e \"$UPSTASH_EMAIL\" --arg k \"$UPSTASH_API_KEY\" '{email:$e, api_key:$k}'"]
}

provider "github" {
  owner = var.github_owner
  # GITHUB_TOKEN via env
}
