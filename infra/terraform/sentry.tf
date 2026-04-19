# Sentry projects. One project per deployable surface so the error feed
# is filterable per-app. All five share the same team (`scani`) so a single
# alert rule covers the lot.
#
# The DSNs are read via `data "sentry_key"` and fanned out as GitHub Actions
# secrets further down (github_actions_secret) — the deploy workflow stages
# them onto Fly (backend/worker) and Cloudflare Pages (frontend/admin/landing).

provider "sentry" {
  token = var.sentry_auth_token
}

data "sentry_organization" "scani" {
  slug = var.sentry_org
}

resource "sentry_team" "scani" {
  organization = data.sentry_organization.scani.slug
  name         = "Scani"
  slug         = "scani"
}

resource "sentry_project" "backend" {
  organization = data.sentry_organization.scani.slug
  teams        = [sentry_team.scani.slug]
  name         = "scani-backend"
  slug         = "scani-backend"
  platform     = "node"
}

resource "sentry_project" "worker" {
  organization = data.sentry_organization.scani.slug
  teams        = [sentry_team.scani.slug]
  name         = "scani-worker"
  slug         = "scani-worker"
  platform     = "node"
}

resource "sentry_project" "frontend" {
  organization = data.sentry_organization.scani.slug
  teams        = [sentry_team.scani.slug]
  name         = "scani-frontend"
  slug         = "scani-frontend"
  platform     = "javascript-react"
}

resource "sentry_project" "admin" {
  organization = data.sentry_organization.scani.slug
  teams        = [sentry_team.scani.slug]
  name         = "scani-admin"
  slug         = "scani-admin"
  platform     = "javascript-nextjs"
}

resource "sentry_project" "landing" {
  organization = data.sentry_organization.scani.slug
  teams        = [sentry_team.scani.slug]
  name         = "scani-landing"
  slug         = "scani-landing"
  platform     = "javascript-react"
}

# Default DSN per project. The provider returns a `dsn` object with nested
# public/secret/csp/cdn variants; we use `dsn.public` (the ingest endpoint
# SDKs expect). `dsn_public` was the flat shape on older provider versions
# and is deprecated as of jianyuan/sentry 0.14.
data "sentry_key" "backend" {
  organization = data.sentry_organization.scani.slug
  project      = sentry_project.backend.slug
  first        = true
}

data "sentry_key" "worker" {
  organization = data.sentry_organization.scani.slug
  project      = sentry_project.worker.slug
  first        = true
}

data "sentry_key" "frontend" {
  organization = data.sentry_organization.scani.slug
  project      = sentry_project.frontend.slug
  first        = true
}

data "sentry_key" "admin" {
  organization = data.sentry_organization.scani.slug
  project      = sentry_project.admin.slug
  first        = true
}

data "sentry_key" "landing" {
  organization = data.sentry_organization.scani.slug
  project      = sentry_project.landing.slug
  first        = true
}
