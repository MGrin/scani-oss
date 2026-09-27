---
title: Migrate to Tier 2
description: Switch provider processing without moving your database or uploaded files.
sidebar:
  order: 3
---

1. Back up your database, S3 bucket and existing `.env`. Keep the same
   `ENCRYPTION_KEY`; rotating it makes stored credentials unreadable.
2. Upgrade the cloud service first, then API and worker to a release supporting
   `processing.v1`. Apply the release's database migrations as usual.
3. Keep your existing database and S3 configuration. If a previous configuration
   stored files on a remote operator's bucket, copy those objects to your own
   bucket while preserving keys before switching storage routing. Changing an
   endpoint does not copy files.
4. Set `SCANI_DEPLOYMENT_TIER=2`, the cloud URL and your customer cloud key on
   API and worker. Remove local platform-provider keys and SMTP credentials.
5. Add `docker-compose.tier2.yml` to your compose invocation or set
   `COMPOSE_FILE=docker-compose.prod.yml:docker-compose.tier2.yml` in `.env`.
   Recreate the API and worker. The overlay does not delete old containers;
   stop your own unused local data-provider and mail catcher explicitly.
6. Exercise email sign-in, document import, pricing and wallet sync. Check that
   uploads remain in your bucket and queued work completes.

The installer preserves an existing `.env`; rerunning it does not select a new
tier or replace stored secrets. Edit the routing values yourself when migrating.

To return to Tier 1, set `SCANI_DEPLOYMENT_TIER=1`, restore the local
`SCANI_CLOUD_URL` and matching local bearer, provide the provider credentials
you need, and use the base compose file. Your database and S3 stay where they are.
