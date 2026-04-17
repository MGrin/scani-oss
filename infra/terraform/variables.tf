variable "domain" {
  type        = string
  description = "Primary domain (e.g. scani.xyz)"
  default     = "scani.xyz"
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID that owns the DNS zone, Pages project, and R2 bucket"
}

variable "fly_org" {
  type        = string
  description = "Fly.io organization slug"
  default     = "personal"
}

variable "neon_org_id" {
  type        = string
  description = "Neon organization ID for the scani project"
  default     = "org-autumn-dust-88271133"
}

variable "github_owner" {
  type        = string
  description = "GitHub owner (user or org) that owns the repo"
  default     = "MGrin"
}

variable "github_repo" {
  type        = string
  description = "GitHub repository name"
  default     = "scani"
}

variable "fly_region" {
  type        = string
  description = "Fly.io region for backend + worker (sin = Singapore, matches old Render region)"
  default     = "sin"
}

variable "neon_region" {
  type        = string
  description = "Neon region ID (e.g. aws-ap-southeast-1 for Singapore)"
  default     = "aws-ap-southeast-1"
}

variable "upstash_region" {
  type        = string
  description = "Upstash Redis region"
  default     = "ap-southeast-1"
}

variable "fly_api_token" {
  type        = string
  description = "Fly.io deploy token (mirrored into GH Secrets). Set via TF_VAR_fly_api_token."
  sensitive   = true
}
