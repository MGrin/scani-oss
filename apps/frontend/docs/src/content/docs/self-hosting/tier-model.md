---
title: Tier model
description: Choose who hosts your data and who manages upstream provider credentials.
sidebar:
  order: 1
---

| Responsibility | Tier 1 — fully self-hosted | Tier 2 — cloud processing | Tier 3 — managed |
|---|---|---|---|
| UI, API and worker | You | You | Scani |
| Database and S3 | You | You | Scani |
| AI, prices and supported chain queries | Local providers | Scani Cloud | Scani |
| Platform API keys | You obtain provider keys | One Scani Cloud key | Scani |
| Authentication email | Your SMTP/Fastmail | Scani Cloud templates | Scani |

Tier 2 keeps durable financial records, uploaded files, users and personal
integration credentials on your infrastructure. Scani Cloud performs requested
provider-backed processing using Scani's upstream accounts. You do not need
OpenAI, CoinGecko, Finnhub, Etherscan, Helius or Google provider credentials.

Set `SCANI_DEPLOYMENT_TIER=1` or `2` explicitly on both API and worker. A cloud
URL alone does not select Tier 2. Managed deployments use `3`; leaving the tier
unset preserves legacy routing for existing managed installations.

Tier 1 uses `SCANI_CLOUD_URL=http://data-provider:8082` and a generated local
bearer matching `DATA_PROVIDER_API_KEY`. This is an internal secret, not a paid
Scani Cloud subscription key. Tier 2 uses `https://api.cloud.scani.xyz` and a key
from [Scani Cloud](https://cloud.scani.xyz).

Both self-hosted tiers still require local database/S3 credentials, a session
secret and an encryption key. The installer generates those. Personal exchange
keys and brokerage tokens are separate: enter them in your local Scani instance.
Those integrations continue to connect directly using your own credentials.

Self-hosting does not mean offline operation. Tier 1 contacts upstream services
directly. Tier 2 sends the inputs needed for processing to Scani Cloud and the
relevant upstream provider. For example, document extraction sends document
content; wallet queries send the public wallet address. Cloud processing does
not require access to your database or S3 credentials.

- [Tier 1 setup](/self-hosting/tier1/production/)
- [Tier 2 setup](/self-hosting/tier2/wiring/)
- [Tier 3](/self-hosting/tier3/)
