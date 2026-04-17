# Upstash Redis. BullMQ + Redis rate-limiter + WS pub/sub all share this
# one database. TLS is on by default; the returned URL uses rediss://.

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
