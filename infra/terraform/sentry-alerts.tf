# Sentry issue-alert rules. Round-3 production-readiness pass — prior to this
# the only safety net was a human checking the Sentry inbox. These rules at
# least page the team's configured notification channel on three signals:
#
#   1. First seen — any brand-new issue group surfaces immediately.
#   2. Regression — a previously-resolved issue starts firing again.
#   3. Volume spike — any single issue exceeds 100 events in 1 hour.
#
# We use IssueOwners notification (delivers to the team configured on the
# project) rather than a hardcoded email list so rotation goes through
# Sentry's UI, not a Terraform PR.

locals {
  sentry_alert_actions = jsonencode([
    {
      id               = "sentry.mail.actions.NotifyEmailAction"
      targetType       = "IssueOwners"
      targetIdentifier = ""
    }
  ])

  sentry_alert_conditions_first_seen = jsonencode([
    { id = "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition" }
  ])

  sentry_alert_conditions_regression = jsonencode([
    { id = "sentry.rules.conditions.regression_event.RegressionEventCondition" }
  ])

  sentry_alert_conditions_volume_spike = jsonencode([
    {
      id             = "sentry.rules.conditions.event_frequency.EventFrequencyCondition"
      interval       = "1h"
      value          = 100
      comparisonType = "count"
    }
  ])

  sentry_backend_projects = {
    backend       = sentry_project.backend.slug
    worker        = sentry_project.worker.slug
    data_provider = sentry_project.data_provider.slug
  }

  sentry_frontend_projects = {
    frontend = sentry_project.frontend.slug
    admin    = sentry_project.admin.slug
    landing  = sentry_project.landing.slug
  }
}

resource "sentry_issue_alert" "backend_first_seen" {
  for_each     = local.sentry_backend_projects
  organization = data.sentry_organization.scani.slug
  project      = each.value
  name         = "[${each.key}] new issue surfaced"

  action_match = "any"
  filter_match = "any"
  frequency    = 5

  conditions = local.sentry_alert_conditions_first_seen
  actions    = local.sentry_alert_actions
}

resource "sentry_issue_alert" "backend_regression" {
  for_each     = local.sentry_backend_projects
  organization = data.sentry_organization.scani.slug
  project      = each.value
  name         = "[${each.key}] resolved issue regressed"

  action_match = "any"
  filter_match = "any"
  frequency    = 5

  conditions = local.sentry_alert_conditions_regression
  actions    = local.sentry_alert_actions
}

resource "sentry_issue_alert" "backend_volume_spike" {
  for_each     = local.sentry_backend_projects
  organization = data.sentry_organization.scani.slug
  project      = each.value
  name         = "[${each.key}] issue exceeded 100 events / hour"

  action_match = "any"
  filter_match = "any"
  frequency    = 60

  conditions = local.sentry_alert_conditions_volume_spike
  actions    = local.sentry_alert_actions
}

resource "sentry_issue_alert" "frontend_first_seen" {
  for_each     = local.sentry_frontend_projects
  organization = data.sentry_organization.scani.slug
  project      = each.value
  name         = "[${each.key}] new issue surfaced"

  action_match = "any"
  filter_match = "any"
  frequency    = 5

  conditions = local.sentry_alert_conditions_first_seen
  actions    = local.sentry_alert_actions
}

resource "sentry_issue_alert" "frontend_regression" {
  for_each     = local.sentry_frontend_projects
  organization = data.sentry_organization.scani.slug
  project      = each.value
  name         = "[${each.key}] resolved issue regressed"

  action_match = "any"
  filter_match = "any"
  frequency    = 5

  conditions = local.sentry_alert_conditions_regression
  actions    = local.sentry_alert_actions
}

resource "sentry_issue_alert" "frontend_volume_spike" {
  for_each     = local.sentry_frontend_projects
  organization = data.sentry_organization.scani.slug
  project      = each.value
  name         = "[${each.key}] issue exceeded 100 events / hour"

  action_match = "any"
  filter_match = "any"
  frequency    = 60

  conditions = local.sentry_alert_conditions_volume_spike
  actions    = local.sentry_alert_actions
}
