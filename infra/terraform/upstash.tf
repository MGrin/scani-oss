# Upstash Redis — admin-app REST storage only (spend overrides, audit
# log, page cache). BullMQ + rate-limiter + WS pub/sub moved to the
# redis-server embedded in the scani-worker machine (2026-07 cost
# reduction; see github.tf redis_url) — their idle polling billed ~$40/mo
# on Upstash's per-command pricing, while the admin's occasional REST
# reads/writes stay within pennies. Keep this database: it holds durable
# operator records and is the only Redis reachable from Cloudflare Pages.

resource "upstash_redis_database" "scani" {
  database_name  = "scani"
  region         = "global"
  primary_region = var.upstash_region
  tls            = true
  eviction       = false
}

output "redis_url" {
  value     = upstash_redis_database.scani.endpoint
  sensitive = false
}

output "redis_connection_string" {
  value     = "rediss://default:${upstash_redis_database.scani.password}@${upstash_redis_database.scani.endpoint}:${upstash_redis_database.scani.port}"
  sensitive = true
}
