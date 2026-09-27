---
title: Why the three-tier deployment model
description: Separate data ownership from the burden of managing provider accounts.
---

Scani supports three operational models with the same application schema.

- **Tier 1:** operate the complete stack and manage upstream provider credentials.
- **Tier 2:** operate UI, API, worker, database and S3; use one Scani Cloud key
  for platform processing and data-provider requests.
- **Tier 3:** use Scani's fully managed application.

Tier 2 separates durable data ownership from provider operations. The customer
owns records, uploads and personal exchange/broker credentials. Scani Cloud
manages AI and supported market/blockchain providers, processes the necessary
inputs and returns results to the customer's worker for local persistence.

Deployment selection is explicit through `SCANI_DEPLOYMENT_TIER`. Storage does
not follow the presence of a cloud key. Both self-hosted tiers retain local S3;
customer cloud keys cannot call internal storage or arbitrary-email endpoints.
Authentication email uses constrained templates instead.

The provider capability interfaces keep application logic independent of local
versus remote processing. The versioned `processing.v1` contract sends minimal
asset identifiers, public wallet addresses and requested document content. It
preserves decimal strings, timestamps and incomplete-history warnings.

Tier 2 involves processing data outside the customer's network. It offers
control over durable storage, not an offline or zero-egress deployment.

See the [tier model](/self-hosting/tier-model/) and
[Tier 2 overview](/self-hosting/tier2/overview/) for current requirements.
