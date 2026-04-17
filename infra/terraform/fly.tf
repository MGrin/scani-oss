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
