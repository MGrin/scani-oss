# Fly.io apps. Terraform owns the app shells + secrets; machine lifecycle
# is managed by `flyctl deploy` from CI, triggered by .github/workflows/deploy.yaml.

resource "fly_app" "backend" {
  name = "scani-backend"
  org  = var.fly_org
}

resource "fly_app" "worker" {
  name = "scani-worker"
  org  = var.fly_org
}

# Data-provider owns every outbound Scani-managed third-party API call.
# See apps/data-provider/README.md for the scope boundary vs. backend.
resource "fly_app" "data_provider" {
  name = "scani-data-provider"
  org  = var.fly_org
}

resource "fly_ip" "data_provider_v4" {
  app  = fly_app.data_provider.name
  type = "v4"
}

resource "fly_ip" "data_provider_v6" {
  app  = fly_app.data_provider.name
  type = "v6"
}

# Custom domain + Let's Encrypt cert for api.cloud.scani.xyz. The
# matching CNAME lives in cloudflare.tf; once DNS propagates Fly's
# ACME client picks up the challenge and issues the cert within a
# minute. Depends on the v4+v6 IPs being allocated first so the DNS
# validation has a reachable target.
resource "fly_cert" "data_provider_api_cloud" {
  app        = fly_app.data_provider.name
  hostname   = local.api_cloud_host
  depends_on = [fly_ip.data_provider_v4, fly_ip.data_provider_v6]
}

# Shared v4 IP (free) + dedicated v6 for the backend. Worker has no inbound
# traffic, so no IPs are allocated for it.
resource "fly_ip" "backend_v4" {
  app  = fly_app.backend.name
  type = "v4"
}

resource "fly_ip" "backend_v6" {
  app  = fly_app.backend.name
  type = "v6"
}

# Machine-count guardrail. A zombie machine arises when a deploy leaves
# an extra (e.g. after an interrupted rollout) or when fly creates an HA
# standby pair and one half lingers. `flyctl scale count 1` on its own
# can destroy the PRIMARY and leave a stopped standby behind — which is
# exactly what happened in April 2026 on scani-worker, and took prod
# async jobs down for hours.
#
# This guardrail runs in two passes:
#   1. Destroy any machine carrying a `standby_for` config — that marker
#      is only ever set during HA pair creation; a solo primary never has it.
#   2. After purging standbys, scale to exactly 1 so any remaining zombies
#      are removed. With `--ha=false` in the deploy flow and standbys
#      purged first, this cannot accidentally kill the primary.
resource "terraform_data" "backend_machine_count" {
  triggers_replace = [timestamp()]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      app="${fly_app.backend.name}"
      # Purge standby machines first.
      for mid in $(flyctl machine list --app "$app" --json \
          | jq -r '.[] | select(.config.standbys != null and (.config.standbys | length) > 0) | .id'); do
        echo "Destroying standby machine $mid on $app"
        flyctl machine destroy "$mid" --app "$app" --force --yes
      done
      # Then scale to 1.
      flyctl scale count 1 --app "$app" --region sin --yes
    EOT
  }

  depends_on = [fly_app.backend]
}

resource "terraform_data" "worker_machine_count" {
  triggers_replace = [timestamp()]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      app="${fly_app.worker.name}"
      for mid in $(flyctl machine list --app "$app" --json \
          | jq -r '.[] | select(.config.standbys != null and (.config.standbys | length) > 0) | .id'); do
        echo "Destroying standby machine $mid on $app"
        flyctl machine destroy "$mid" --app "$app" --force --yes
      done
      flyctl scale count 1 --app "$app" --region sin --yes
    EOT
  }

  depends_on = [fly_app.worker]
}

resource "terraform_data" "data_provider_machine_count" {
  triggers_replace = [timestamp()]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      app="${fly_app.data_provider.name}"
      # On the very first apply the Fly app has been freshly created
      # but deploy-fly hasn't run yet, so there are zero machines.
      # `flyctl scale count` needs at least one existing machine to
      # use as a template ("could not create a fly.toml from any
      # machines"), so skip both the standby purge and the scale on
      # the empty case — the next apply (after deploy-fly creates
      # the first machine) will enforce the count.
      machine_count=$(flyctl machine list --app "$app" --json | jq 'length')
      if [ "$machine_count" -eq 0 ]; then
        echo "No machines on $app yet — skipping count enforcement (deploy-fly will create them)"
        exit 0
      fi
      for mid in $(flyctl machine list --app "$app" --json \
          | jq -r '.[] | select(.config.standbys != null and (.config.standbys | length) > 0) | .id'); do
        echo "Destroying standby machine $mid on $app"
        flyctl machine destroy "$mid" --app "$app" --force --yes
      done
      # Scale to 2 — every backend + worker call hops through this
      # service, so a single-machine cutover would 5xx every outbound
      # request for ~30s. Mirrors apps/data-provider/fly.toml's
      # min/max_machines_running = 2 + rolling deploy strategy.
      flyctl scale count 2 --app "$app" --region sin --yes
    EOT
  }

  depends_on = [fly_app.data_provider]
}
