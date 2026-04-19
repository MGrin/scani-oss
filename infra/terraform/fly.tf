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
