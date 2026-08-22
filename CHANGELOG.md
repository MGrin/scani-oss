# Changelog

## [0.14.1](https://github.com/MGrin/scani-oss/commit/9ddd39960cd6ef2df3f61e983a0a20ef78dfa12c) (2026-08-21)

Published to Docker Hub by hand from `scripts/publish-images-local.sh`, built from
[`9ddd399`](https://github.com/MGrin/scani-oss/commit/9ddd39960cd6ef2df3f61e983a0a20ef78dfa12c).
There is no `v0.14.1` git tag and release-please did not cut this release, so it has no
generated entry above.

Because the last tag in this repository is `v0.12.0`, the next generated section will
cover every commit since `v0.12.0` — including the ones already published as 0.13.0,
0.14.0 and this release. Use the three commits named in these three sections as the
boundaries when attributing a change to the image tag it actually shipped in.

Every published image records its own source commit, so this mapping is checkable rather
than asserted:

```
docker buildx imagetools inspect scani/frontend-app:0.14.1 --format '{{json .Image}}'
```

## [0.14.0](https://github.com/MGrin/scani-oss/commit/9c96e4cad5d1741d53288656151a3f972750dabd) (2026-08-21)

Published to Docker Hub by hand from `scripts/publish-images-local.sh`, built from
[`9c96e4c`](https://github.com/MGrin/scani-oss/commit/9c96e4cad5d1741d53288656151a3f972750dabd).
No `v0.14.0` git tag, no generated entry.

## [0.13.0](https://github.com/MGrin/scani-oss/commit/83d628d991e7043da5de374bea1a848e27f139bc) (2026-08-20)

Published to Docker Hub by hand from `scripts/publish-images-local.sh`, built from
[`83d628d`](https://github.com/MGrin/scani-oss/commit/83d628d991e7043da5de374bea1a848e27f139bc).
No `v0.13.0` git tag, no generated entry.

These three releases were published while GitHub Actions was billing-blocked and the
tag-driven `docker-publish.yml` could not run. They are recorded here rather than tagged
retroactively: a `v0.13.0` tag today would fire `docker-publish.yml`, rebuild 0.13.0 from
a different commit under a tag people have already pulled, and move `:latest` backwards.

## [0.12.0](https://github.com/MGrin/scani-oss/compare/v0.11.0...v0.12.0) (2026-08-12)


### Features

* **ai:** carry the invoice schema through the cloud AI path ([0a5265f](https://github.com/MGrin/scani-oss/commit/0a5265fabbed65bdfd7cc35162cf583c474b37d6))
* **app:** a Files page listing every uploaded file ([b199e34](https://github.com/MGrin/scani-oss/commit/b199e348bf37d7b9861a77a52f17cf6fecbbecc9))
* **app:** pre-fill a recurring payment from an approved invoice ([1f3ab22](https://github.com/MGrin/scani-oss/commit/1f3ab228e1867673a3ae6d2382449476c1640277))
* **app:** put Payments in the mobile tab bar, in place of Holdings ([a538809](https://github.com/MGrin/scani-oss/commit/a538809ab53972900af44a427ff60bccb349e374))
* backport the invoice→payment bridge, document lifecycle and Files page ([b7913a8](https://github.com/MGrin/scani-oss/commit/b7913a8fe58104c4257e15d764164fd09d628636))
* **documents:** extract paid status + billing period from invoices ([85ddb61](https://github.com/MGrin/scani-oss/commit/85ddb6149fdbecab4435eb6ab7b47ee77b7aeca8))
* **documents:** one row per uploaded file, for every purpose ([7db3a2e](https://github.com/MGrin/scani-oss/commit/7db3a2e2e3cae7957e7170165aa6d3a9c4541565))
* **documents:** re-parse a document with the current extractor ([cd0a017](https://github.com/MGrin/scani-oss/commit/cd0a017da1421ab9a55552f410864c0d07a7050e))
* **documents:** retain the uploaded file, and delete a document ([d8e57e7](https://github.com/MGrin/scani-oss/commit/d8e57e778aa6722f692647318a6ef15fcfa0b7ac))
* **payments:** bridge an approved invoice into a recurring payment ([0afc5a1](https://github.com/MGrin/scani-oss/commit/0afc5a166aff0fc50581587f679b10b943c6fea0))
* **providers:** move OpenAI to gpt-5.6-luna for both text and vision ([a9bf085](https://github.com/MGrin/scani-oss/commit/a9bf0854fe7e107a5e2981830d985d92d5de4865))


### Bug Fixes

* **documents:** keep a failed upload, and carry the user's filename ([12eaae6](https://github.com/MGrin/scani-oss/commit/12eaae6b8d863f04a7c2475e58abf1f99e1e0979))
* **documents:** let the invoice prompt replace the holdings schema ([b5517b7](https://github.com/MGrin/scani-oss/commit/b5517b7949c87d02e9ab3762606221eea16c6079))
* **documents:** route on the text a PDF yields, not a per-page OCR verdict ([56ca728](https://github.com/MGrin/scani-oss/commit/56ca7282ffe929adb047dfcd3d2d4291d66635cc))
* **documents:** wire the Files page to the API the backend actually built ([182bef2](https://github.com/MGrin/scani-oss/commit/182bef24eba1cc50cc4a51a97ab900f7ed57ec42))
* **e2e:** point globalSetup at the wait-for-stack script that exists ([e1467d0](https://github.com/MGrin/scani-oss/commit/e1467d0935944882c74a3555b58a4b2fae9e03d0))
* **e2e:** point globalSetup at the wait-for-stack script that exists ([30c8a55](https://github.com/MGrin/scani-oss/commit/30c8a5557bcb649719e3e909310ea7c65e400ea1))
* **e2e:** resolve the e2e root via import.meta.url, not import.meta.dir ([116148e](https://github.com/MGrin/scani-oss/commit/116148ed9db18869d97a8777990aaf7b8fd2c01e))
* **jobs:** let a parsed invoice be opened from its job page ([a7495ec](https://github.com/MGrin/scani-oss/commit/a7495ec123acf98f91441a2e833cf6449c231bb2))
* **payments:** keep settled occurrences on the schedule when it moves ([eda76f3](https://github.com/MGrin/scani-oss/commit/eda76f377ea04cb7f78ea301ce0f96db49a13d60))
* **payments:** read the extraction by id, and narrow its text columns ([820330d](https://github.com/MGrin/scani-oss/commit/820330dc73220d8ca178aa44323988b46434046a))
* **payments:** rewrite every derived row on a schedule change ([bba94cb](https://github.com/MGrin/scani-oss/commit/bba94cbdf6d97ab31061a646787885b4386fe114))
* **payments:** say how many payments exist, not just what's due ([e84dc6a](https://github.com/MGrin/scani-oss/commit/e84dc6aafbf16ccdada339e7ac5ce0e38de29f6f))
* **providers:** send a scanned PDF as a file part, not an image part ([90ec17d](https://github.com/MGrin/scani-oss/commit/90ec17dfbad9738254460ae77b63073a8eff0daa))
* **providers:** send the request shape gpt-5.6-luna actually accepts ([84f0218](https://github.com/MGrin/scani-oss/commit/84f02185e38d1d8b17cf6aa5975e58d285f5afd7))

## [0.11.0](https://github.com/MGrin/scani-oss/compare/v0.10.1...v0.11.0) (2026-08-11)


### Features

* **payments:** recurring bills and income, with invoice ingestion ([210b5b0](https://github.com/MGrin/scani-oss/commit/210b5b0a91790c7ac4ffa8e34eb9d63d790a931f))
* **payments:** recurring bills and income, with invoice ingestion ([7e6f888](https://github.com/MGrin/scani-oss/commit/7e6f888b1d92da6958fe265e211e13e99c517c96))

## [0.10.1](https://github.com/MGrin/scani-oss/compare/v0.10.0...v0.10.1) (2026-08-10)


### Bug Fixes

* **frontend:** drop aborted-fetch noise from Sentry across all engines ([00ed9e1](https://github.com/MGrin/scani-oss/commit/00ed9e1844e21cc95fedc05dd1d1b76e174d98cc))
* **frontend:** drop aborted-fetch noise from Sentry across all engines ([0ba7c74](https://github.com/MGrin/scani-oss/commit/0ba7c7497be65c7fd78d11dea8b9b8d816bb1ce0))

## [0.10.0](https://github.com/MGrin/scani-oss/compare/v0.9.4...v0.10.0) (2026-07-21)


### Features

* **accounts:** provider-driven account type, editable type, account-level "Sync now" ([#81](https://github.com/MGrin/scani-oss/issues/81)) ([92b4d22](https://github.com/MGrin/scani-oss/commit/92b4d220979369c5994d48692ee4eac8aa0a2119))


### Bug Fixes

* **logging:** correct prod log service labels; own env vars via config.ts loader ([16df0e1](https://github.com/MGrin/scani-oss/commit/16df0e161caf2a6a642dde4828e75557f380ead7))
* **logging:** prod service labels + config.ts env loader; sync CLAUDE.md layout ([699c6de](https://github.com/MGrin/scani-oss/commit/699c6deeb2c6bb7d13194e5241c3c37eee18fbfd))

## [0.9.4](https://github.com/MGrin/scani-oss/compare/v0.9.3...v0.9.4) (2026-07-20)


### Bug Fixes

* **providers:** drop IBKR short positions and margin-debt cash from balances ([3e578d5](https://github.com/MGrin/scani-oss/commit/3e578d588fbd31584fca0e3c94913c8cdb135638))
* **providers:** drop IBKR short positions and margin-debt cash from balances ([b1a903b](https://github.com/MGrin/scani-oss/commit/b1a903b6781e5113290f4e839c16df3be77d5ae5))

## [0.9.3](https://github.com/MGrin/scani-oss/compare/v0.9.2...v0.9.3) (2026-07-12)


### Bug Fixes

* **app:** don't double-toast mutation errors that have their own onError ([9a4f303](https://github.com/MGrin/scani-oss/commit/9a4f303a49cb59d8a332bbe8a0dff44d859f39c4))
* **app:** surface a toast on transient network errors instead of failing silently ([19ed56e](https://github.com/MGrin/scani-oss/commit/19ed56e4ba2ace624a85b165684fed67042ce8fa))
* **bybit:** chunk deposit/withdrawal queries into &lt;=30d windows ([be6f909](https://github.com/MGrin/scani-oss/commit/be6f9099209cbcdf192c5132f6b9c4f50d2aa4d9))


### Performance Improvements

* **token-prices:** DISTINCT ON latest-price lookup to avoid full scans ([f8c6734](https://github.com/MGrin/scani-oss/commit/f8c6734052df9eafb180974d61a37d54b1bf048e))

## [0.9.2](https://github.com/MGrin/scani-oss/compare/v0.9.1...v0.9.2) (2026-07-07)


### Bug Fixes

* **holdings:** stop balance sync from overwriting manual holdings ([d36a65e](https://github.com/MGrin/scani-oss/commit/d36a65e96ac3ced62bbf80937b7a9100125c9fd4))
* **holdings:** stop balance sync from overwriting manual holdings ([fdffdae](https://github.com/MGrin/scani-oss/commit/fdffdaef02af3cf2f0d33c0d05221668a06f488e))

## [0.9.1](https://github.com/MGrin/scani-oss/compare/v0.9.0...v0.9.1) (2026-07-05)


### Bug Fixes

* **observability:** stop Sentry floods from empty exchange links and bot 404s ([9087dc1](https://github.com/MGrin/scani-oss/commit/9087dc1f28c844e15ba9cc57e403485779a684c0))
* **observability:** stop Sentry floods from empty exchange links and bot 404s ([95e03ef](https://github.com/MGrin/scani-oss/commit/95e03ef91aead2d7695bbb50acb4a0ec301e51f4))

## [0.9.0](https://github.com/MGrin/scani-oss/compare/v0.8.0...v0.9.0) (2026-07-03)


### Features

* **admin:** move spend overrides + operator audit log into Postgres ([7fbab6e](https://github.com/MGrin/scani-oss/commit/7fbab6e4e61e52e077dc6d30a2a8f623219594c0))
* **admin:** move spend overrides + operator audit log into Postgres ([61f6201](https://github.com/MGrin/scani-oss/commit/61f620164a0b221e9bfccae42bac489ef90e504d))
* **queue:** embedded-Redis support + quarter-hour cadence for frequent jobs ([4fad732](https://github.com/MGrin/scani-oss/commit/4fad73280a60e71af28a7decfc55759097766a38))
* **queue:** embedded-Redis support + quarter-hour cadence for frequent jobs ([c9aa03d](https://github.com/MGrin/scani-oss/commit/c9aa03d939c3dd085990bf08adfe3ae183ea58c8))

## [0.8.0](https://github.com/MGrin/scani-oss/compare/v0.7.0...v0.8.0) (2026-07-02)


### Features

* **pricing:** homoglyph scam detection + intraday-price downsampling job ([73edcf3](https://github.com/MGrin/scani-oss/commit/73edcf3817796426c06eb8ef613e40039ec83bae))
* **pricing:** homoglyph scam detection + intraday-price downsampling job ([63c7e3d](https://github.com/MGrin/scani-oss/commit/63c7e3d6292215aa2f27e311abb4db26f07992f2))

## [0.7.0](https://github.com/MGrin/scani-oss/compare/v0.6.0...v0.7.0) (2026-06-27)


### Features

* **transactions:** recurring daily transaction-sync job ([32619a0](https://github.com/MGrin/scani-oss/commit/32619a07ff446016ecd8ca7c3bd05e8b2c866240))

## [0.6.0](https://github.com/MGrin/scani-oss/compare/v0.5.2...v0.6.0) (2026-06-27)


### Features

* **app:** show last-synced time + stale badge per account ([c24391d](https://github.com/MGrin/scani-oss/commit/c24391d7db21b2974a9249f9d88cfda900119b72))
* **domain:** findSyncableInstitutions — capability/type driven sync selection ([a5e28b0](https://github.com/MGrin/scani-oss/commit/a5e28b05c37d1621e1a5659c8b705b921aa1ea72))
* **worker:** stale-sync probe → Sentry alert for silently-stalled integrations ([ac80ccd](https://github.com/MGrin/scani-oss/commit/ac80ccde3aacd9a320b80629e2fb944af3d42554))


### Bug Fixes

* **import:** make markCredentialFailed fully best-effort + real success-path test ([78f34e3](https://github.com/MGrin/scani-oss/commit/78f34e3ebcf86b04137884e66364a7fc35613701))
* **import:** mark credential failed + Sentry on terminal exchange-import failure ([4bccf3f](https://github.com/MGrin/scani-oss/commit/4bccf3f6e1fe89f044a19783fa2183154fa886ad))
* **queue:** give repeatable jobs attempts+backoff so transient DB drops don't dead-letter ([6f70ea8](https://github.com/MGrin/scani-oss/commit/6f70ea85d7490778811258d836918ec261865cf6))
* **sync:** select sync institutions via registry capability, not name list ([c72ff1f](https://github.com/MGrin/scani-oss/commit/c72ff1f4b9b41f97b4be28413b1feac2e7ccece8))
* **ui:** make PWA detection SSR-safe in PullToRefresh ([a1783d1](https://github.com/MGrin/scani-oss/commit/a1783d1b7437114c889978b3d0be9c125640fe34))
* **ui:** make PWA detection SSR-safe in PullToRefresh ([acb569c](https://github.com/MGrin/scani-oss/commit/acb569ce57fbd75ea8a4ed3f8abb3ad9e84180bc))

## [0.5.2](https://github.com/MGrin/scani-oss/compare/v0.5.1...v0.5.2) (2026-05-31)


### Bug Fixes

* **app:** redirect to app when already signed in on the /auth screen ([ed4f4e5](https://github.com/MGrin/scani-oss/commit/ed4f4e5779c579c549d63892c9bbe2e4583e7221))
* **app:** redirect to app when already signed in on the /auth screen ([2344079](https://github.com/MGrin/scani-oss/commit/2344079b09af96042d0bb4086c7a8f8c9317d6ac))

## [0.5.1](https://github.com/MGrin/scani-oss/compare/v0.5.0...v0.5.1) (2026-05-27)


### Bug Fixes

* **deps:** pin @sinclair/typebox ^0.34 in api + data-provider ([5bd0ba9](https://github.com/MGrin/scani-oss/commit/5bd0ba9aaa107bbe39d51cf7c2efce9af0a69945))
* **deps:** pin @sinclair/typebox ^0.34 in api + data-provider ([5f3f544](https://github.com/MGrin/scani-oss/commit/5f3f544ca2154a62a1d5c083c768dc9d41748e09))
* **docker:** pin bun install to --linker=hoisted in service builds ([cc45a95](https://github.com/MGrin/scani-oss/commit/cc45a95df41a2c082b33b5812b38206b7c2aefdf))
* **docker:** pin bun install to --linker=hoisted in service builds ([d94e54b](https://github.com/MGrin/scani-oss/commit/d94e54b3eda90633717e8a4e3029a9f75235c07f))

## [0.5.0](https://github.com/MGrin/scani-oss/compare/v0.4.0...v0.5.0) (2026-05-26)


### Features

* **data-provider:** STUB_AI=1 env mode for deterministic screenshot-parse ([3aab1dc](https://github.com/MGrin/scani-oss/commit/3aab1dc2b1cd9143e9b380ab49debe0b10c34cfc))
* **e2e:** browser-driven end-to-end test suite with Playwright ([e9b36ee](https://github.com/MGrin/scani-oss/commit/e9b36ee2d6e332562f46bfde50e18a9cef296b1d))
* **e2e:** mailpit/db/stack-readiness helpers + globalSetup ([24c9553](https://github.com/MGrin/scani-oss/commit/24c95534b8c55cc6bb0a9769c23d5ea88cbd3300))
* **e2e:** mode A/B orchestrator for bun test:e2e ([b1313c9](https://github.com/MGrin/scani-oss/commit/b1313c9efd750c0b3454253854b595be9faf19aa))
* **e2e:** scaffold @scani/e2e workspace with Playwright config ([f0b4cc9](https://github.com/MGrin/scani-oss/commit/f0b4cc9953794ad2577ce3e18f4026de31cd5f06))
* **e2e:** signIn fixture + OTP sign-in spec ([80adb5b](https://github.com/MGrin/scani-oss/commit/80adb5bc2029b9ad39e8de94cabe219ae3e99b47))
* **shared:** add safeExternalUrl URL-scheme guard ([0da2a6c](https://github.com/MGrin/scani-oss/commit/0da2a6cdca922ab22a8f674596f9cb130416f33a))


### Bug Fixes

* **api:** apply signup limiter to change-email + change-password (L4) ([20cc310](https://github.com/MGrin/scani-oss/commit/20cc3101d702296e8dbe7366998389de47ba94bd))
* **api:** disable Better-Auth password endpoints (unused, OTP-only UX) ([b9a2151](https://github.com/MGrin/scani-oss/commit/b9a21517dc9211bdb7c66be7fbe1f96feb93a229))
* **api:** hash magic-link tokens and OTPs in DB (M1) ([0496481](https://github.com/MGrin/scani-oss/commit/04964816d9b8a1cc664d9ca66dd63b47b44621d7))
* **api:** per-user rate limit on sessions.revoke + revokeOthers (M3) ([741441a](https://github.com/MGrin/scani-oss/commit/741441a4e5c4e25d85dcf93e43f1b6c1c5461c2e))
* **api:** require fresh session (5min) for change-email/password (L5) ([05a079d](https://github.com/MGrin/scani-oss/commit/05a079daffcf252225df76bf9b56a13605a439f5))
* **api:** tighten session cookie to SameSite=Strict (M4) ([cd684c5](https://github.com/MGrin/scani-oss/commit/cd684c5640ae888d6205e2c8165f57f1c1edb61d))
* **data-provider:** mirror H1+M1 to cloud auth (disable password endpoints, hash tokens) ([8ea2a64](https://github.com/MGrin/scani-oss/commit/8ea2a64a9ea5ac29acded1c0fa052debe16647b6))
* **e2e:** address CI failures + CodeQL findings ([8343ea6](https://github.com/MGrin/scani-oss/commit/8343ea68ec3942470a01c6876e8989d43a74b960))
* **e2e:** de-flake custom-institution-add spec (institution name overflow) ([ddb1261](https://github.com/MGrin/scani-oss/commit/ddb1261c3eeac496a2688092bbea67aa7c38d947))
* **e2e:** drop unused @scani/shared + stub scripts/run.ts for knip ([5a11ad5](https://github.com/MGrin/scani-oss/commit/5a11ad5def3e1c1e183f424835a7dd5b1afa277b))
* **e2e:** pin COMPOSE_PROJECT_NAME in CI + use API_BASE_URL consistently ([506314a](https://github.com/MGrin/scani-oss/commit/506314ac77e26ccff8db7e1332974e28591d6d87))
* **frontend:** drop Sentry tracing+replay integrations (CSP eval block) ([4ca34cb](https://github.com/MGrin/scani-oss/commit/4ca34cb1e05b8514ac0a8566dad76573ac98a165))
* **frontend:** guard institution.website href against javascript: URIs ([273da39](https://github.com/MGrin/scani-oss/commit/273da3909805211de64bd45db6e6181f802f4426))
* **frontend:** guard instructions.docsUrl href against javascript: URIs ([61ab81d](https://github.com/MGrin/scani-oss/commit/61ab81df4bc82be1e164ac7f43d287f053ca13b5))
* **frontend:** mirror backend Permissions-Policy / COOP / CORP on SPA ([ca12eff](https://github.com/MGrin/scani-oss/commit/ca12effa1d9fba6e918139abf2cb5744c344db22))
* **security:** explicit scrypt params N=2^15 (M6) ([5030e72](https://github.com/MGrin/scani-oss/commit/5030e726e1515cbc0112aaeb46d70e1282067b1d))
* **shared:** remove duplicate @scani/shared/utils/encryption module (H4) ([51b39db](https://github.com/MGrin/scani-oss/commit/51b39dbbc69399669c3c2c5dc8306cd223779df7))
* **test:** scope root bun test to backend+frontend, exclude apps/e2e ([e1aab59](https://github.com/MGrin/scani-oss/commit/e1aab59c031c38245f771890a459f831bfe6d609))

## [0.4.0](https://github.com/MGrin/scani-oss/compare/v0.3.0...v0.4.0) (2026-05-25)


### Bug Fixes

* post-OSS-readiness-audit blockers (X-1, X-4) ([d8ed7a4](https://github.com/MGrin/scani-oss/commit/d8ed7a495e070a07b6925b0d0697fe952c892cc8))
* **X-1:** use Bun.env to defeat compile-time NODE_ENV substitution ([bae8eaa](https://github.com/MGrin/scani-oss/commit/bae8eaafec11746fc98fd90e4de7f1ef202a78d7))


### Miscellaneous Chores

* release as 0.4.0 ([ebef313](https://github.com/MGrin/scani-oss/commit/ebef31325380585b7f4b953401eeee6b13beb3d1))

## [0.3.0](https://github.com/MGrin/scani-oss/compare/v0.2.2...v0.3.0) (2026-05-25)


### Features

* **readme,docs:** add social links for [@scani](https://github.com/scani)_xyz and [@scani](https://github.com/scani).xyz ([aa97415](https://github.com/MGrin/scani-oss/commit/aa9741504eedd90e1b8a2da68225c7ac1a4440ae))
* **readme,docs:** add social links for [@scani](https://github.com/scani)_xyz and [@scani](https://github.com/scani).xyz ([1c11350](https://github.com/MGrin/scani-oss/commit/1c113504245a224d5a66b4a8189ef46d64ceade8))


### Bug Fixes

* **ci:** sync-readmes skips missing Docker Hub repos; drop stale sha tag docs ([c45813d](https://github.com/MGrin/scani-oss/commit/c45813d5acdee6184a55f5eb5f401a62e6eae7e3))
* **ci:** sync-readmes tolerates missing repos + drops stale sha tag docs ([9cdcd6d](https://github.com/MGrin/scani-oss/commit/9cdcd6dc18c21968bfdecdb87157fdd9a7a50118))
* **distribution:** make tier-1 paths actually work ([6bb513f](https://github.com/MGrin/scani-oss/commit/6bb513ffc48cd81f40a7149949cc44e028aad742))
* **distribution:** make tier-1 paths actually work ([8363a80](https://github.com/MGrin/scani-oss/commit/8363a8089e81f1e925352beae8f57e37fc441cb0))
* **N-1:** defeat bun --compile NODE_ENV build-time inlining ([5395dcb](https://github.com/MGrin/scani-oss/commit/5395dcb91b88a745c53ce29bc3818512cc1567ef))
* **N-1:** remove deprecated isProduction const, use isNodeEnvProduction() everywhere ([0faae56](https://github.com/MGrin/scani-oss/commit/0faae56fdf8c19dc4e025763d16ab16ade4a4dae))
* **N-2:** make every dev-compose host port env-overridable ([6c48131](https://github.com/MGrin/scani-oss/commit/6c481319f64732fb28f878beb07836bfdc69d4c7))
* **N-3:** add dev:worker / dev:data-provider scripts, fix PORT collision ([695e8d6](https://github.com/MGrin/scani-oss/commit/695e8d6236b1d522be11de765945a8fabb092394))
* **N-6:** slim scani/migrate image via bun --compile ([bb43b63](https://github.com/MGrin/scani-oss/commit/bb43b6380423508dc285c392f57348924438c761))
* **N-7:** unify api Dockerfile port to 3001 + /readyz healthcheck ([30b15a0](https://github.com/MGrin/scani-oss/commit/30b15a0f10145c4d677ef1f76f20881d36985281))
* **pnl:** cover Binance Funding + P2P, realize PnL on unlinked exits ([5453982](https://github.com/MGrin/scani-oss/commit/54539826700dacb29edd8fedbcecf912e580c0b1))

## [0.2.2](https://github.com/MGrin/scani-oss/compare/v0.2.1...v0.2.2) (2026-05-23)


### Bug Fixes

* **docker:** set NODE_ENV=production in the build stage so bun-build inlines correctly ([0ef9485](https://github.com/MGrin/scani-oss/commit/0ef9485aba4f57890d1404fd1743afd1229d994d))
* **docker:** set NODE_ENV=production in the build stage so bun-build inlines correctly ([1852477](https://github.com/MGrin/scani-oss/commit/185247736e2a44b82c64d205c0e1f4c257740f2d))

## [0.2.1](https://github.com/MGrin/scani-oss/compare/v0.2.0...v0.2.1) (2026-05-23)


### Bug Fixes

* **security:** bound regex quantifiers to close polynomial-redos alerts ([ce1a30d](https://github.com/MGrin/scani-oss/commit/ce1a30d97b9d885028e6ce684e0853585fc29f7f))
* **security:** bound regex quantifiers to close polynomial-redos alerts ([7d6e988](https://github.com/MGrin/scani-oss/commit/7d6e98802c9349f3e6353f839158d151023f78d3))

## [0.2.0](https://github.com/MGrin/scani-oss/compare/v0.1.1...v0.2.0) (2026-05-23)


### Features

* **frontend:** community translations via i18n ([6c351e2](https://github.com/MGrin/scani-oss/commit/6c351e2f010e28107972d57119866799bb806ac4))

## [0.1.1](https://github.com/MGrin/scani-oss/compare/scani-v0.1.0...scani-v0.1.1) (2026-05-23)


### Bug Fixes

* treat empty-string SENTRY_DSN / optional URL env vars as unset ([d29495d](https://github.com/MGrin/scani-oss/commit/d29495de81f05e2809eef41466e7b46f5dc2f2e5))
* treat empty-string SENTRY_DSN / optional URL env vars as unset ([a0e8565](https://github.com/MGrin/scani-oss/commit/a0e85656136b034260e819adc3ddf9af46664a13))
