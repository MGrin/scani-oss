# Upstash was retired in the 2026-07 cost reduction:
#   - BullMQ / rate-limiter / realtime pub-sub moved to the redis-server
#     embedded in the scani-worker Fly machine (see github.tf redis_url).
#   - The admin app's durable data (spend overrides, operator audit log)
#     moved to Postgres behind the backend's HMAC-gated /admin/* routes;
#     its page cache became in-memory.
# The `upstash_redis_database.scani` resource was removed here so the
# apply that merges this file DESTROYS the database (recorded invoice
# actuals + audit history were copied to Postgres first).
#
# The provider block (main.tf), required_providers entry (versions.tf),
# `upstash_region` variable, and the UPSTASH_EMAIL / UPSTASH_API_KEY
# CI secrets must stay until that destroy apply has run — Terraform
# needs the provider to delete the resource from state. Remove them all
# (and this file) in a follow-up once the apply is green.
