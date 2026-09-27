---
title: Personal integration credentials
description: Your exchange and brokerage credentials remain under your control.
sidebar:
  order: 4
---

The one-key Tier 2 promise covers **platform providers**: AI, market prices,
blockchain data and authentication email. Scani manages those provider accounts.

An exchange or brokerage connection still needs your personal authorization.
Enter those credentials in your own Scani UI. Your API encrypts them with your
local `ENCRYPTION_KEY` and stores them in your database. The API and worker use
them locally; they are not sent to Scani Cloud.

Public-wallet processing sends only the wallet address and the requested data
range. It never forwards an exchange credential resolver, API secret or private
key. Never enter a wallet seed phrase or signing key.

Future cloud bank connectors, including Salt Edge, will have their own consent
flow. They are not enabled by this release.
