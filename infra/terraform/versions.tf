terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
    fly = {
      source  = "fly-apps/fly"
      version = "~> 0.0.23"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.6"
    }
    upstash = {
      source  = "upstash/upstash"
      version = "~> 1.5"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.12"
    }
  }

  # Terraform state lives in a Cloudflare R2 bucket via the S3-compatible API.
  # TF 1.10+ supports native S3 locking (use_lockfile), so we don't need a
  # DynamoDB sidekick.
  backend "s3" {
    bucket = "scani-tfstate"
    key    = "scani/terraform.tfstate"
    region = "auto"
    # Endpoint is the Cloudflare R2 S3 URL for your account. Set via:
    #   export AWS_ENDPOINT_URL_S3=https://<account>.r2.cloudflarestorage.com
    # or add `endpoints = { s3 = "..." }` after `init -reconfigure`.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
    # State locking via DynamoDB isn't available on Cloudflare R2. Locking
    # via `use_lockfile` is TF 1.10+. For a solo developer this is fine;
    # coordinate via git branches instead.
  }
}
