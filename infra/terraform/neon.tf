# Neon Postgres: one project, one main branch. Schema is applied by the
# deploy workflow (bun run db:migrate) against the emitted DATABASE_URL.

resource "neon_project" "scani" {
  name                      = "scani"
  org_id                    = var.neon_org_id
  region_id                 = var.neon_region
  pg_version                = 16
  history_retention_seconds = 21600 # 6h — Neon free-plan maximum

  branch {
    name = "main"
  }
}

output "database_url_direct" {
  value     = neon_project.scani.connection_uri
  sensitive = true
}

output "database_url_pooled" {
  value     = neon_project.scani.connection_uri_pooler
  sensitive = true
}

output "database_host" {
  value = neon_project.scani.database_host
}
