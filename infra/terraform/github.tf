# GitHub Actions secrets — fan out from Terraform-managed values so the
# deploy workflow can pick them up without the user manually pasting them
# into the GitHub Secrets UI.
#
# Note: the `production` environment + required-reviewer approval gate is
# NOT managed here because the fine-grained PAT would need Environments
# admin scope, which conflicts with "this repo only" scoping. Create the
# environment once in the GitHub UI; repo secrets below are sufficient
# for the deploy workflow.

data "github_repository" "scani" {
  full_name = "${var.github_owner}/${var.github_repo}"
}

resource "github_actions_secret" "database_url_direct" {
  repository      = data.github_repository.scani.name
  secret_name     = "DATABASE_URL_DIRECT"
  plaintext_value = neon_project.scani.connection_uri
}

resource "github_actions_secret" "redis_url" {
  repository      = data.github_repository.scani.name
  secret_name     = "REDIS_URL"
  plaintext_value = "rediss://default:${upstash_redis_database.scani.password}@${upstash_redis_database.scani.endpoint}:${upstash_redis_database.scani.port}"
}

resource "github_actions_secret" "fly_api_token" {
  repository      = data.github_repository.scani.name
  secret_name     = "FLY_API_TOKEN"
  plaintext_value = var.fly_api_token
}
