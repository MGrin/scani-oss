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

# Machine-count guardrail. `flyctl deploy` occasionally leaves orphan machines
# behind after a strategy change or failed deploy; `max_machines_running` in
# fly.toml only caps the Fly auto-scaler, it does not destroy machines that
# already exist. Runs `flyctl scale count 1` on every apply — idempotent when
# the count is already correct, destroys extras when it isn't.
resource "terraform_data" "backend_machine_count" {
  triggers_replace = [timestamp()]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      flyctl scale count 1 \
        --app ${fly_app.backend.name} \
        --region sin \
        --yes
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
      flyctl scale count 1 \
        --app ${fly_app.worker.name} \
        --region sin \
        --yes
    EOT
  }

  depends_on = [fly_app.worker]
}
