# PostHog product analytics — dashboards + insights as code.
#
# The PostHog *project* itself is not managed here: it was created in the
# PostHog UI (its `phc_` key arrives via var.posthog_project_key, sourced
# from a GitHub secret — never committed). This file owns the marketing/
# product analytics views inside that project so they are reproducible and
# reviewed in git rather than clicked together.
#
# Provider auth is env-driven (see .github/workflows/terraform.yaml):
#   POSTHOG_API_KEY     — a personal API key (phx_...) scoped to the
#                         project with insight:write + dashboard:write.
#   POSTHOG_PROJECT_ID  — the numeric project id (from the PostHog URL).
#   POSTHOG_HOST        — regional API host, https://eu.posthog.com.
#
# Note: the official PostHog provider has no `cohort` resource yet, so
# persona cohorts are not codified here — segment via the breakdown
# insights below (country / language / device) and PostHog person
# properties instead.

provider "posthog" {
  # POSTHOG_API_KEY / POSTHOG_PROJECT_ID / POSTHOG_HOST read from env.
}

# Reused query fragments. PostHog insights take a serialized query node
# (an InsightVizNode wrapping a Trends/Funnels/Paths/Retention query).
locals {
  ph_30d = { date_from = "-30d" }
  ph_90d = { date_from = "-90d" }
}

# ---------------------------------------------------------------------------
# Marketing Overview — visitors, geography, languages, journeys, funnels.
# ---------------------------------------------------------------------------
resource "posthog_dashboard" "marketing" {
  name        = "Marketing Overview"
  description = "Visits, geography, languages, journeys and conversion funnels across landing / app / cloud."
  pinned      = true
  tags        = ["scani", "marketing"]
}

resource "posthog_insight" "pageviews" {
  name          = "Pageviews (30d)"
  description   = "Total pageviews across all surfaces."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind         = "TrendsQuery"
      series       = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "total" }]
      interval     = "day"
      dateRange    = local.ph_30d
      trendsFilter = { display = "ActionsLineGraph" }
    }
  })
}

resource "posthog_insight" "unique_visitors" {
  name          = "Unique visitors (30d)"
  description   = "Distinct visitors per day."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind         = "TrendsQuery"
      series       = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "dau" }]
      interval     = "day"
      dateRange    = local.ph_30d
      trendsFilter = { display = "ActionsLineGraph" }
    }
  })
}

resource "posthog_insight" "pageviews_by_app" {
  name          = "Pageviews by app"
  description   = "Landing vs app vs cloud split."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind            = "TrendsQuery"
      series          = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "total" }]
      interval        = "day"
      dateRange       = local.ph_30d
      breakdownFilter = { breakdown = "app", breakdown_type = "event" }
      trendsFilter    = { display = "ActionsBar" }
    }
  })
}

resource "posthog_insight" "visitors_by_country" {
  name          = "Visitors by country"
  description   = "Geographic distribution (GeoIP)."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind            = "TrendsQuery"
      series          = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "dau" }]
      dateRange       = local.ph_30d
      breakdownFilter = { breakdown = "$geoip_country_name", breakdown_type = "event" }
      trendsFilter    = { display = "WorldMap" }
    }
  })
}

resource "posthog_insight" "visitors_by_language" {
  name          = "Visitors by language"
  description   = "Browser language of visitors."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind            = "TrendsQuery"
      series          = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "dau" }]
      dateRange       = local.ph_30d
      breakdownFilter = { breakdown = "language", breakdown_type = "event" }
      trendsFilter    = { display = "ActionsBarValue" }
    }
  })
}

resource "posthog_insight" "visitors_by_device" {
  name          = "Visitors by device type"
  description   = "Desktop / mobile / tablet split."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind            = "TrendsQuery"
      series          = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "dau" }]
      dateRange       = local.ph_30d
      breakdownFilter = { breakdown = "$device_type", breakdown_type = "event" }
      trendsFilter    = { display = "ActionsPie" }
    }
  })
}

resource "posthog_insight" "top_pages" {
  name          = "Top pages"
  description   = "Most-viewed paths across all surfaces."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind            = "TrendsQuery"
      series          = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "total" }]
      dateRange       = local.ph_30d
      breakdownFilter = { breakdown = "$pathname", breakdown_type = "event" }
      trendsFilter    = { display = "ActionsTable" }
    }
  })
}

resource "posthog_insight" "activation_funnel" {
  name          = "Activation funnel"
  description   = "Visit -> sign up -> connect an account -> finish an import."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind = "FunnelsQuery"
      series = [
        { kind = "EventsNode", event = "$pageview", name = "$pageview" },
        { kind = "EventsNode", event = "user_signed_up", name = "user_signed_up" },
        { kind = "EventsNode", event = "account_connected", name = "account_connected" },
        { kind = "EventsNode", event = "import_completed", name = "import_completed" },
      ]
      dateRange     = local.ph_90d
      funnelsFilter = { funnelWindowInterval = 14, funnelWindowIntervalUnit = "day" }
    }
  })
}

resource "posthog_insight" "waitlist_conversion" {
  name          = "Waitlist conversion"
  description   = "Landing visit -> joined the beta waitlist."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind = "FunnelsQuery"
      series = [
        { kind = "EventsNode", event = "$pageview", name = "$pageview" },
        { kind = "EventsNode", event = "waitlist_joined", name = "waitlist_joined" },
      ]
      dateRange = local.ph_90d
    }
  })
}

resource "posthog_insight" "user_paths" {
  name          = "User paths"
  description   = "Where visitors go — journeys and drop-off."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind        = "PathsQuery"
      dateRange   = local.ph_30d
      pathsFilter = { includeEventTypes = ["$pageview"] }
    }
  })
}

resource "posthog_insight" "weekly_retention" {
  name          = "Weekly retention"
  description   = "Returning-visitor retention, week over week."
  dashboard_ids = [posthog_dashboard.marketing.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind      = "RetentionQuery"
      dateRange = local.ph_90d
      retentionFilter = {
        period          = "Week"
        retentionType   = "retention_first_time"
        targetEntity    = { id = "$pageview", name = "$pageview", type = "events" }
        returningEntity = { id = "$pageview", name = "$pageview", type = "events" }
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Email Engagement — sent / opened / clicked for transactional + marketing.
# ---------------------------------------------------------------------------
resource "posthog_dashboard" "email" {
  name        = "Email Engagement"
  description = "Sent / opened / clicked rates for transactional and marketing email."
  tags        = ["scani", "email"]
}

resource "posthog_insight" "emails_sent_by_template" {
  name          = "Emails sent by template"
  description   = "Send volume per email template."
  dashboard_ids = [posthog_dashboard.email.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind            = "TrendsQuery"
      series          = [{ kind = "EventsNode", event = "email_sent", name = "email_sent", math = "total" }]
      dateRange       = local.ph_30d
      breakdownFilter = { breakdown = "template", breakdown_type = "event" }
      trendsFilter    = { display = "ActionsTable" }
    }
  })
}

resource "posthog_insight" "email_funnel" {
  name          = "Email funnel: sent -> opened -> clicked"
  description   = "Engagement funnel across all email."
  dashboard_ids = [posthog_dashboard.email.id]
  query_json = jsonencode({
    kind = "InsightVizNode"
    source = {
      kind = "FunnelsQuery"
      series = [
        { kind = "EventsNode", event = "email_sent", name = "email_sent" },
        { kind = "EventsNode", event = "email_opened", name = "email_opened" },
        { kind = "EventsNode", event = "email_link_clicked", name = "email_link_clicked" },
      ]
      dateRange = local.ph_90d
    }
  })
}
