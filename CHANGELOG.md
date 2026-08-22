# Changelog

<!--
The heading SHAPE in this file is functional, not cosmetic.

release-please inserts each new release directly under this `# Changelog`
heading, immediately above the first heading that matches a version pattern
(`## [0.12.0]…`). Measured on this repo: commit b06ffc2, `chore(main): release
0.12.0`, whose CHANGELOG hunk is `@@ -1,5 +1,40 @@`.

The 0.13.0, 0.14.0 and 0.14.1 sections below are hand-written — those versions
were published without a git tag — and they are given version-shaped headings so
that a future release is inserted ABOVE them, in the right chronological place.
Retitle them to prose and the next release gets tucked underneath them instead.

For the same reason each of those sections repeats its own explanation rather
than sharing a preamble: anything written between `# Changelog` and the first
version heading stays there permanently, above every future release. This
comment is deliberately in that position; explanatory prose should not be.
-->

## [0.4.0](https://github.com/MGrin/scani-oss/compare/v0.14.1...v0.4.0) (2026-08-22)


### Features

* **accounts:** provider-driven account type, editable type, account-level "Sync now" ([#81](https://github.com/MGrin/scani-oss/issues/81)) ([92b4d22](https://github.com/MGrin/scani-oss/commit/92b4d220979369c5994d48692ee4eac8aa0a2119))
* **admin:** move spend overrides + operator audit log into Postgres ([7fbab6e](https://github.com/MGrin/scani-oss/commit/7fbab6e4e61e52e077dc6d30a2a8f623219594c0))
* **admin:** move spend overrides + operator audit log into Postgres ([61f6201](https://github.com/MGrin/scani-oss/commit/61f620164a0b221e9bfccae42bac489ef90e504d))
* **ai:** carry the invoice schema through the cloud AI path ([0a5265f](https://github.com/MGrin/scani-oss/commit/0a5265fabbed65bdfd7cc35162cf583c474b37d6))
* **alerts:** tell a user when an on-chain wallet stops syncing (SC-470) ([e92f3bd](https://github.com/MGrin/scani-oss/commit/e92f3bdfe52520a2f93052a6e25b97718b2cc780))
* **alerts:** tell a user when an on-chain wallet stops syncing (SC-470) ([7b62c04](https://github.com/MGrin/scani-oss/commit/7b62c040785938c430357576ed10f35905ac983a))
* **app:** a Files page listing every uploaded file ([b199e34](https://github.com/MGrin/scani-oss/commit/b199e348bf37d7b9861a77a52f17cf6fecbbecc9))
* **app:** pre-fill a recurring payment from an approved invoice ([1f3ab22](https://github.com/MGrin/scani-oss/commit/1f3ab228e1867673a3ae6d2382449476c1640277))
* **app:** put Payments in the mobile tab bar, in place of Holdings ([a538809](https://github.com/MGrin/scani-oss/commit/a538809ab53972900af44a427ff60bccb349e374))
* **app:** show last-synced time + stale badge per account ([c24391d](https://github.com/MGrin/scani-oss/commit/c24391d7db21b2974a9249f9d88cfda900119b72))
* **app:** the v3 interface — one design language across every surface ([04ac19d](https://github.com/MGrin/scani-oss/commit/04ac19dde09c3875a34bab48a5f69c597bdc3368))
* **app:** the v3 interface — one design language across every surface ([c0d56ad](https://github.com/MGrin/scani-oss/commit/c0d56ad6f3e3e1a3f5b2769edd05546f31dda9a9))
* backport the invoice→payment bridge, document lifecycle and Files page ([b7913a8](https://github.com/MGrin/scani-oss/commit/b7913a8fe58104c4257e15d764164fd09d628636))
* **data-provider:** STUB_AI=1 env mode for deterministic screenshot-parse ([3aab1dc](https://github.com/MGrin/scani-oss/commit/3aab1dc2b1cd9143e9b380ab49debe0b10c34cfc))
* **demo:** a deterministic cross-border portfolio to demo without an account (SC-465) ([257c521](https://github.com/MGrin/scani-oss/commit/257c521374cb86fb5913c539c9acbd68d50fe387))
* **demo:** a deterministic cross-border portfolio to demo without an account (SC-465) ([24d7e59](https://github.com/MGrin/scani-oss/commit/24d7e599ca4ff66de895e3a1d5ad8c8927063e19))
* **demo:** seed an empty demo database on the worker's first boot ([9c96e4c](https://github.com/MGrin/scani-oss/commit/9c96e4cad5d1741d53288656151a3f972750dabd))
* **demo:** seed an empty demo database on the worker's first boot ([2c9d11f](https://github.com/MGrin/scani-oss/commit/2c9d11f8c22eca7967ddcaa67068b427c359493c))
* **demo:** unauthenticated read-only demo mode with a scheduled reset (SC-466) ([0d6300a](https://github.com/MGrin/scani-oss/commit/0d6300a27e9ed5bc9ce631a5e09a28f71cd09ad1))
* **demo:** unauthenticated read-only demo mode with a scheduled reset (SC-466) ([be62ed9](https://github.com/MGrin/scani-oss/commit/be62ed91fd75e95717065c2e2f90a1fb074ae088))
* **docs:** derive docs:check lists from git, and add three checks (SC-170) ([851cb93](https://github.com/MGrin/scani-oss/commit/851cb930d5015c5e33a13bf87909fa17c682bb26))
* **docs:** derive docs:check lists from git, and add three checks (SC-170) ([b90e3a8](https://github.com/MGrin/scani-oss/commit/b90e3a8db29aaf12e69d9650329e2a74ce425de5))
* **docs:** link the no-signup demo from the docs splash hero (SC-507) ([a10e339](https://github.com/MGrin/scani-oss/commit/a10e339dfbc7dd62f3a10b30ca0eea63d9e77d2f))
* **docs:** link the no-signup demo from the docs splash hero (SC-507) ([81a6f28](https://github.com/MGrin/scani-oss/commit/81a6f28a5cbd5c6d4a45b7491a574147a650ca28))
* **documents:** extract paid status + billing period from invoices ([85ddb61](https://github.com/MGrin/scani-oss/commit/85ddb6149fdbecab4435eb6ab7b47ee77b7aeca8))
* **documents:** one row per uploaded file, for every purpose ([7db3a2e](https://github.com/MGrin/scani-oss/commit/7db3a2e2e3cae7957e7170165aa6d3a9c4541565))
* **documents:** re-parse a document with the current extractor ([cd0a017](https://github.com/MGrin/scani-oss/commit/cd0a017da1421ab9a55552f410864c0d07a7050e))
* **documents:** retain the uploaded file, and delete a document ([d8e57e7](https://github.com/MGrin/scani-oss/commit/d8e57e778aa6722f692647318a6ef15fcfa0b7ac))
* **domain:** findSyncableInstitutions — capability/type driven sync selection ([a5e28b0](https://github.com/MGrin/scani-oss/commit/a5e28b05c37d1621e1a5659c8b705b921aa1ea72))
* **e2e:** browser-driven end-to-end test suite with Playwright ([e9b36ee](https://github.com/MGrin/scani-oss/commit/e9b36ee2d6e332562f46bfde50e18a9cef296b1d))
* **e2e:** mailpit/db/stack-readiness helpers + globalSetup ([24c9553](https://github.com/MGrin/scani-oss/commit/24c95534b8c55cc6bb0a9769c23d5ea88cbd3300))
* **e2e:** mode A/B orchestrator for bun test:e2e ([b1313c9](https://github.com/MGrin/scani-oss/commit/b1313c9efd750c0b3454253854b595be9faf19aa))
* **e2e:** port the screenshot harness ([6196bee](https://github.com/MGrin/scani-oss/commit/6196bee4d4e3804683c4e8ea3f07cd67fdfb6ea1))
* **e2e:** port the screenshot harness ([2248cb5](https://github.com/MGrin/scani-oss/commit/2248cb55ec74f0e16c5d4e7bb3182865423e9dd4))
* **e2e:** scaffold @scani/e2e workspace with Playwright config ([f0b4cc9](https://github.com/MGrin/scani-oss/commit/f0b4cc9953794ad2577ce3e18f4026de31cd5f06))
* **e2e:** signIn fixture + OTP sign-in spec ([80adb5b](https://github.com/MGrin/scani-oss/commit/80adb5bc2029b9ad39e8de94cabe219ae3e99b47))
* **frontend:** community translations via i18n ([6c351e2](https://github.com/MGrin/scani-oss/commit/6c351e2f010e28107972d57119866799bb806ac4))
* **frontend:** wire i18n into the SPA so translations are a first-class contribution ([9dcfb8d](https://github.com/MGrin/scani-oss/commit/9dcfb8de7edbc1ff74c8422bba028b2ea6d10c32))
* **holdings:** manual balance edits become transactions, not performance (SC-510) ([16d92bd](https://github.com/MGrin/scani-oss/commit/16d92bd8792403afedc5df4ca630f337ff4f4113))
* **holdings:** manual balance edits become transactions, not performance (SC-510) ([4136e02](https://github.com/MGrin/scani-oss/commit/4136e027352dd6dd75802ef12628d9a203d49355))
* **icons:** proxy institution favicons instead of calling Google (SC-208) ([f64b376](https://github.com/MGrin/scani-oss/commit/f64b3764cc0e2f6e023f4360101a693e2133f253))
* **payments:** bridge an approved invoice into a recurring payment ([0afc5a1](https://github.com/MGrin/scani-oss/commit/0afc5a166aff0fc50581587f679b10b943c6fea0))
* **payments:** recurring bills and income, with invoice ingestion ([210b5b0](https://github.com/MGrin/scani-oss/commit/210b5b0a91790c7ac4ffa8e34eb9d63d790a931f))
* **payments:** recurring bills and income, with invoice ingestion ([7e6f888](https://github.com/MGrin/scani-oss/commit/7e6f888b1d92da6958fe265e211e13e99c517c96))
* **portfolio:** say what a figure does not know, and let a transfer be answered ([c21efdf](https://github.com/MGrin/scani-oss/commit/c21efdf8c0203d156fa636edf4f0ad2cac4f6e82))
* **portfolio:** say what a figure does not know, and let a transfer be answered ([c65d781](https://github.com/MGrin/scani-oss/commit/c65d78126cfd7dd6a90e7b3ab9e5be738a8cea68))
* **pricing:** homoglyph scam detection + intraday-price downsampling job ([73edcf3](https://github.com/MGrin/scani-oss/commit/73edcf3817796426c06eb8ef613e40039ec83bae))
* **pricing:** homoglyph scam detection + intraday-price downsampling job ([63c7e3d](https://github.com/MGrin/scani-oss/commit/63c7e3d6292215aa2f27e311abb4db26f07992f2))
* **providers:** move OpenAI to gpt-5.6-luna for both text and vision ([a9bf085](https://github.com/MGrin/scani-oss/commit/a9bf0854fe7e107a5e2981830d985d92d5de4865))
* **queue:** embedded-Redis support + quarter-hour cadence for frequent jobs ([4fad732](https://github.com/MGrin/scani-oss/commit/4fad73280a60e71af28a7decfc55759097766a38))
* **queue:** embedded-Redis support + quarter-hour cadence for frequent jobs ([c9aa03d](https://github.com/MGrin/scani-oss/commit/c9aa03d939c3dd085990bf08adfe3ae183ea58c8))
* **queue:** move BullMQ from Redis to the Postgres backend (SC-518) ([afe9789](https://github.com/MGrin/scani-oss/commit/afe9789e890ae1d0de4d9730652f71df49c679fa))
* **queue:** move BullMQ from Redis to the Postgres backend (SC-518) ([1c117c4](https://github.com/MGrin/scani-oss/commit/1c117c4ac8e9aafc8828bceca229166aeadfb873))
* **queue:** upgrade BullMQ 5.77.3 -&gt; 6.2.0, still on Redis (SC-518) ([f9dce41](https://github.com/MGrin/scani-oss/commit/f9dce4134f4525d3f760efd05ccf68dad40e48bf))
* **queue:** upgrade BullMQ 5.77.3 -&gt; 6.2.0, still on Redis (SC-518) ([7a33953](https://github.com/MGrin/scani-oss/commit/7a3395304ed4857bd8d87326695142707eb281fd))
* **rate-limiter:** bound the Redis waits so an outage cannot hang a caller ([b9401d6](https://github.com/MGrin/scani-oss/commit/b9401d6277081d8234ee2c82c9352893d76231ba))
* **readme,docs:** add social links for [@scani](https://github.com/scani)_xyz and [@scani](https://github.com/scani).xyz ([aa97415](https://github.com/MGrin/scani-oss/commit/aa9741504eedd90e1b8a2da68225c7ac1a4440ae))
* **readme,docs:** add social links for [@scani](https://github.com/scani)_xyz and [@scani](https://github.com/scani).xyz ([1c11350](https://github.com/MGrin/scani-oss/commit/1c113504245a224d5a66b4a8189ef46d64ceade8))
* **shared:** add safeExternalUrl URL-scheme guard ([0da2a6c](https://github.com/MGrin/scani-oss/commit/0da2a6cdca922ab22a8f674596f9cb130416f33a))
* **tokens:** carry lookalike_of through the token schema and its constructors ([1fca62a](https://github.com/MGrin/scani-oss/commit/1fca62a87f16b44c7ee13679428858ebf4322eca))
* **tokens:** carry lookalike_of through the token schema and its constructors ([d295fce](https://github.com/MGrin/scani-oss/commit/d295fce76feb2f7b9fb727989aefd7ac3e6bb3d2))
* **transactions:** recurring daily transaction-sync job ([32619a0](https://github.com/MGrin/scani-oss/commit/32619a07ff446016ecd8ca7c3bd05e8b2c866240))
* **ui:** the v3 design system — tokens, primitives, list surface, exports ([5a9dd47](https://github.com/MGrin/scani-oss/commit/5a9dd472068bd3a7e1d74043ea52e82ac23d4d68))
* **ui:** the v3 design system — tokens, primitives, list surface, exports ([0c2f50f](https://github.com/MGrin/scani-oss/commit/0c2f50fcb8e3ca2ef1fbba89d0c379205a4af1fa))
* **v3:** forward-port the v3 interface and its dependencies to the mirror ([f6e9995](https://github.com/MGrin/scani-oss/commit/f6e9995adc7decfee13c01b10f97af0e4fe9ab7e))
* **v3:** forward-port the v3 interface and its dependencies to the mirror ([f09e38e](https://github.com/MGrin/scani-oss/commit/f09e38e7b70308fca33e7465922732b8226e05d2))
* **worker:** stale-sync probe → Sentry alert for silently-stalled integrations ([ac80ccd](https://github.com/MGrin/scani-oss/commit/ac80ccde3aacd9a320b80629e2fb944af3d42554))


### Bug Fixes

* **alerts:** constrain the wallet probe's join to the account's own user ([7be2d98](https://github.com/MGrin/scani-oss/commit/7be2d9898de1f2faa890d8baebdf8742d5bae23b))
* **api:** apply signup limiter to change-email + change-password (L4) ([20cc310](https://github.com/MGrin/scani-oss/commit/20cc3101d702296e8dbe7366998389de47ba94bd))
* **api:** disable Better-Auth password endpoints (unused, OTP-only UX) ([b9a2151](https://github.com/MGrin/scani-oss/commit/b9a21517dc9211bdb7c66be7fbe1f96feb93a229))
* **api:** hash magic-link tokens and OTPs in DB (M1) ([0496481](https://github.com/MGrin/scani-oss/commit/04964816d9b8a1cc664d9ca66dd63b47b44621d7))
* **api:** per-user rate limit on sessions.revoke + revokeOthers (M3) ([741441a](https://github.com/MGrin/scani-oss/commit/741441a4e5c4e25d85dcf93e43f1b6c1c5461c2e))
* **api:** require fresh session (5min) for change-email/password (L5) ([05a079d](https://github.com/MGrin/scani-oss/commit/05a079daffcf252225df76bf9b56a13605a439f5))
* **api:** tighten session cookie to SameSite=Strict (M4) ([cd684c5](https://github.com/MGrin/scani-oss/commit/cd684c5640ae888d6205e2c8165f57f1c1edb61d))
* **app:** don't double-toast mutation errors that have their own onError ([9a4f303](https://github.com/MGrin/scani-oss/commit/9a4f303a49cb59d8a332bbe8a0dff44d859f39c4))
* **app:** redirect to app when already signed in on the /auth screen ([ed4f4e5](https://github.com/MGrin/scani-oss/commit/ed4f4e5779c579c549d63892c9bbe2e4583e7221))
* **app:** redirect to app when already signed in on the /auth screen ([2344079](https://github.com/MGrin/scani-oss/commit/2344079b09af96042d0bb4086c7a8f8c9317d6ac))
* **app:** surface a toast on transient network errors instead of failing silently ([19ed56e](https://github.com/MGrin/scani-oss/commit/19ed56e4ba2ace624a85b165684fed67042ce8fa))
* **bybit:** chunk deposit/withdrawal queries into &lt;=30d windows ([be6f909](https://github.com/MGrin/scani-oss/commit/be6f9099209cbcdf192c5132f6b9c4f50d2aa4d9))
* **ci:** a test that pinned ICU, and a cache that outlived its lockfile ([714ce98](https://github.com/MGrin/scani-oss/commit/714ce983597c7db705423009206bdfebf3aa923c))
* **ci:** a test that pinned ICU, and a cache that outlived its lockfile ([caebf28](https://github.com/MGrin/scani-oss/commit/caebf28ea80fdbd4eb60e0fa314659cbd37b8ca1))
* **ci:** sync-readmes skips missing Docker Hub repos; drop stale sha tag docs ([c45813d](https://github.com/MGrin/scani-oss/commit/c45813d5acdee6184a55f5eb5f401a62e6eae7e3))
* **ci:** sync-readmes tolerates missing repos + drops stale sha tag docs ([9cdcd6d](https://github.com/MGrin/scani-oss/commit/9cdcd6dc18c21968bfdecdb87157fdd9a7a50118))
* **cloud-client:** let demo mode run without a data-provider (SC-516) ([e04ac90](https://github.com/MGrin/scani-oss/commit/e04ac903565426bbe464b2ca03cb36408c9907be))
* **cloud-client:** let demo mode run without a data-provider (SC-516) ([c520497](https://github.com/MGrin/scani-oss/commit/c520497efa2b18a784336ee192530860bbd813dc))
* **compose:** name the database host the migration gate refuses to guess ([107e4e2](https://github.com/MGrin/scani-oss/commit/107e4e22f8b954d17000f27b7198cb046bf89310))
* **compose:** route migrate through db:migrate so the queue schema is created ([3b11e33](https://github.com/MGrin/scani-oss/commit/3b11e333511a9b247379b6eb9e2e21a15146ea1d))
* **cost-basis:** a currency conversion is not a transfer (SC-506) ([8288dae](https://github.com/MGrin/scani-oss/commit/8288dae9921516c5a333768db599d4417ee7312f))
* **cost-basis:** a currency conversion is not a transfer (SC-506) ([ae0cd29](https://github.com/MGrin/scani-oss/commit/ae0cd2931c2658466cdff55fe84a95cf275ddfd8))
* **data-provider:** mirror H1+M1 to cloud auth (disable password endpoints, hash tokens) ([8ea2a64](https://github.com/MGrin/scani-oss/commit/8ea2a64a9ea5ac29acded1c0fa052debe16647b6))
* **deps:** pin @sinclair/typebox ^0.34 in api + data-provider ([5bd0ba9](https://github.com/MGrin/scani-oss/commit/5bd0ba9aaa107bbe39d51cf7c2efce9af0a69945))
* **deps:** pin @sinclair/typebox ^0.34 in api + data-provider ([5f3f544](https://github.com/MGrin/scani-oss/commit/5f3f544ca2154a62a1d5c083c768dc9d41748e09))
* **dev:** create the root .env instead of refusing without one ([9d9d8e3](https://github.com/MGrin/scani-oss/commit/9d9d8e34305bdcd96ea1d7ca22182c744ad8e7f4))
* **dev:** create the root .env instead of refusing without one ([f27bd6e](https://github.com/MGrin/scani-oss/commit/f27bd6e7602fb123a322cc56168d711b17675c6b))
* **dev:** create the root .env with an exclusive open, not a check-then-write ([86409a9](https://github.com/MGrin/scani-oss/commit/86409a9c2c37e6816287c63a1c54be8105e8b667))
* **dev:** give the worker its browser URLs, and pin that they follow the port ([88b277d](https://github.com/MGrin/scani-oss/commit/88b277d73e642c4af0b8298a8dcb57c0c9443676))
* **dev:** give the worker its browser URLs, and pin that they follow the port ([0f13dfa](https://github.com/MGrin/scani-oss/commit/0f13dfab5302b5898d50177a4628961512236671))
* **distribution:** make tier-1 paths actually work ([6bb513f](https://github.com/MGrin/scani-oss/commit/6bb513ffc48cd81f40a7149949cc44e028aad742))
* **distribution:** make tier-1 paths actually work ([8363a80](https://github.com/MGrin/scani-oss/commit/8363a8089e81f1e925352beae8f57e37fc441cb0))
* **docker:** drop the bullmq SQL copy from data-provider — it has no queue ([25b7bb9](https://github.com/MGrin/scani-oss/commit/25b7bb911d1fda49e386cba5c7e328db7b803174))
* **docker:** pin bun install to --linker=hoisted in service builds ([cc45a95](https://github.com/MGrin/scani-oss/commit/cc45a95df41a2c082b33b5812b38206b7c2aefdf))
* **docker:** pin bun install to --linker=hoisted in service builds ([d94e54b](https://github.com/MGrin/scani-oss/commit/d94e54b3eda90633717e8a4e3029a9f75235c07f))
* **docker:** set NODE_ENV=production in the build stage so bun-build inlines correctly ([0ef9485](https://github.com/MGrin/scani-oss/commit/0ef9485aba4f57890d1404fd1743afd1229d994d))
* **docker:** set NODE_ENV=production in the build stage so bun-build inlines correctly ([1852477](https://github.com/MGrin/scani-oss/commit/185247736e2a44b82c64d205c0e1f4c257740f2d))
* **docker:** ship BullMQ's Postgres SQL beside the compiled binary (SC-518) ([c29dc75](https://github.com/MGrin/scani-oss/commit/c29dc753a838de057ede46e80602f98308c5ce74))
* **docs:** a wide table scrolls instead of hiding its right-hand columns ([d2b5558](https://github.com/MGrin/scani-oss/commit/d2b55587a33af1828f049f1d8dae28f5133db86d))
* **docs:** a wide table scrolls instead of hiding its right-hand columns ([b70f8ce](https://github.com/MGrin/scani-oss/commit/b70f8ce8d0a2e24364f52d67326998b823e9eb7f))
* **docs:** markdown autolinks are invalid MDX ([83d628d](https://github.com/MGrin/scani-oss/commit/83d628d991e7043da5de374bea1a848e27f139bc))
* **documents:** keep a failed upload, and carry the user's filename ([12eaae6](https://github.com/MGrin/scani-oss/commit/12eaae6b8d863f04a7c2475e58abf1f99e1e0979))
* **documents:** let the invoice prompt replace the holdings schema ([b5517b7](https://github.com/MGrin/scani-oss/commit/b5517b7949c87d02e9ab3762606221eea16c6079))
* **documents:** route on the text a PDF yields, not a per-page OCR verdict ([56ca728](https://github.com/MGrin/scani-oss/commit/56ca7282ffe929adb047dfcd3d2d4291d66635cc))
* **documents:** wire the Files page to the API the backend actually built ([182bef2](https://github.com/MGrin/scani-oss/commit/182bef24eba1cc50cc4a51a97ab900f7ed57ec42))
* **e2e:** address CI failures + CodeQL findings ([8343ea6](https://github.com/MGrin/scani-oss/commit/8343ea68ec3942470a01c6876e8989d43a74b960))
* **e2e:** ask compose what it calls the api, and isolate this checkout's images ([5101b09](https://github.com/MGrin/scani-oss/commit/5101b0989224eb3b80bd0a658e56270fb2df7438))
* **e2e:** ask compose what it calls the api, and isolate this checkout's images ([37eea4d](https://github.com/MGrin/scani-oss/commit/37eea4d03af6c4b30f9aab2b83209927ac436f47))
* **e2e:** de-flake custom-institution-add spec (institution name overflow) ([ddb1261](https://github.com/MGrin/scani-oss/commit/ddb1261c3eeac496a2688092bbea67aa7c38d947))
* **e2e:** drop the SPA boot check's timeout knob ([b2ae448](https://github.com/MGrin/scani-oss/commit/b2ae448de82e351f4a8982547355cac6c32ea8c7))
* **e2e:** drop unused @scani/shared + stub scripts/run.ts for knip ([5a11ad5](https://github.com/MGrin/scani-oss/commit/5a11ad5def3e1c1e183f424835a7dd5b1afa277b))
* **e2e:** give every test its own rate-limit identity ([37d0ad6](https://github.com/MGrin/scani-oss/commit/37d0ad6804f2525c25471267413cdb9cb292c8a4))
* **e2e:** give every test its own rate-limit identity ([86e58c2](https://github.com/MGrin/scani-oss/commit/86e58c242047049e52c712351989a5dc229659cd))
* **e2e:** key the identity on User-Agent, not a custom header ([218c0a1](https://github.com/MGrin/scani-oss/commit/218c0a1f2b80b30c25f68bf2042f18d3ac0343e2))
* **e2e:** let waitForJob outlive the test budget so its message can be printed (SC-498) ([00b3018](https://github.com/MGrin/scani-oss/commit/00b3018d6f02b89c78ffa6697d1dfe84c06bc2f3))
* **e2e:** let waitForJob outlive the test budget so its message can be printed (SC-498) ([28fd19a](https://github.com/MGrin/scani-oss/commit/28fd19a7025e5f7f678ee9790913f8b74127dd21))
* **e2e:** pin COMPOSE_PROJECT_NAME in CI + use API_BASE_URL consistently ([506314a](https://github.com/MGrin/scani-oss/commit/506314ac77e26ccff8db7e1332974e28591d6d87))
* **e2e:** point globalSetup at the wait-for-stack script that exists ([e1467d0](https://github.com/MGrin/scani-oss/commit/e1467d0935944882c74a3555b58a4b2fae9e03d0))
* **e2e:** point globalSetup at the wait-for-stack script that exists ([30c8a55](https://github.com/MGrin/scani-oss/commit/30c8a5557bcb649719e3e909310ea7c65e400ea1))
* **e2e:** resolve the e2e root via import.meta.url, not import.meta.dir ([116148e](https://github.com/MGrin/scani-oss/commit/116148ed9db18869d97a8777990aaf7b8fd2c01e))
* **e2e:** resolve the redis container from compose instead of guessing its name ([3061013](https://github.com/MGrin/scani-oss/commit/3061013960fbf73dfc204a694af98f953dd66c6d))
* **e2e:** stub chain data in the gate, and stop swallowing failed chain probes ([667b9c5](https://github.com/MGrin/scani-oss/commit/667b9c51a984bac1bbfde4171fdfcb7e4c65d838))
* **e2e:** stub chain data in the gate, and stop swallowing failed chain probes ([828c390](https://github.com/MGrin/scani-oss/commit/828c3901e54c38c1030807b5297581d4e706e9e0))
* **e2e:** talk to Redis over its published port, not through docker exec ([41a0625](https://github.com/MGrin/scani-oss/commit/41a06256c2b383c04105ae9a0ae5f58c1cc2adde))
* **e2e:** the runner's `down -v` can only delete a stack it created ([1b500ff](https://github.com/MGrin/scani-oss/commit/1b500fff073c570ef0cdbdb45e6026e339fad900))
* **e2e:** the runner's `down -v` can only delete a stack it created ([141b1ac](https://github.com/MGrin/scani-oss/commit/141b1ac7a59b8687eb770ab8596263cd16188931))
* **e2e:** wait for the query v3's peek titles itself from ([372c525](https://github.com/MGrin/scani-oss/commit/372c52501745615722c96214c24081bce028a11c))
* **e2e:** wait for the query v3's peek titles itself from ([ffa1bf8](https://github.com/MGrin/scani-oss/commit/ffa1bf8d89fd48358fb9a3743eab8eaf4ee88e27))
* **frontend:** drop aborted-fetch noise from Sentry across all engines ([00ed9e1](https://github.com/MGrin/scani-oss/commit/00ed9e1844e21cc95fedc05dd1d1b76e174d98cc))
* **frontend:** drop aborted-fetch noise from Sentry across all engines ([0ba7c74](https://github.com/MGrin/scani-oss/commit/0ba7c7497be65c7fd78d11dea8b9b8d816bb1ce0))
* **frontend:** drop Sentry tracing+replay integrations (CSP eval block) ([4ca34cb](https://github.com/MGrin/scani-oss/commit/4ca34cb1e05b8514ac0a8566dad76573ac98a165))
* **frontend:** guard institution.website href against javascript: URIs ([273da39](https://github.com/MGrin/scani-oss/commit/273da3909805211de64bd45db6e6181f802f4426))
* **frontend:** guard instructions.docsUrl href against javascript: URIs ([61ab81d](https://github.com/MGrin/scani-oss/commit/61ab81df4bc82be1e164ac7f43d287f053ca13b5))
* **frontend:** mirror backend Permissions-Policy / COOP / CORP on SPA ([ca12eff](https://github.com/MGrin/scani-oss/commit/ca12effa1d9fba6e918139abf2cb5744c344db22))
* **frontend:** the published image was a blank page ([d851034](https://github.com/MGrin/scani-oss/commit/d8510344a59c138f202d03befab6eb96b8bf831b))
* **frontend:** the published image was a blank page ([03bea6c](https://github.com/MGrin/scani-oss/commit/03bea6ca7d8cdb733d183abc23d767b60af1606d))
* **holdings:** stop balance sync from overwriting manual holdings ([d36a65e](https://github.com/MGrin/scani-oss/commit/d36a65e96ac3ced62bbf80937b7a9100125c9fd4))
* **holdings:** stop balance sync from overwriting manual holdings ([fdffdae](https://github.com/MGrin/scani-oss/commit/fdffdaef02af3cf2f0d33c0d05221668a06f488e))
* **http-fetch:** the DNS step was outside every timeout, on the OG path too (SC-208) ([fbe0ac0](https://github.com/MGrin/scani-oss/commit/fbe0ac0f0a7dcef0ad02ad9785dd6a0ac5250f91))
* **icons:** an unresolvable API base must be a letter tile, not a thrown render (SC-208) ([de95ea1](https://github.com/MGrin/scani-oss/commit/de95ea12cf24e92155390f8777ab033813d81834))
* **icons:** bound the whole icon resolve, not just its fetches (SC-208) ([39d3cbe](https://github.com/MGrin/scani-oss/commit/39d3cbe5dfbfe00dfc109d575cddb8bd9801298f))
* **import:** make markCredentialFailed fully best-effort + real success-path test ([78f34e3](https://github.com/MGrin/scani-oss/commit/78f34e3ebcf86b04137884e66364a7fc35613701))
* **import:** mark credential failed + Sentry on terminal exchange-import failure ([4bccf3f](https://github.com/MGrin/scani-oss/commit/4bccf3f6e1fe89f044a19783fa2183154fa886ad))
* **install:** pin the hoisted linker so a fresh install produces a usable tree ([110b57f](https://github.com/MGrin/scani-oss/commit/110b57f93b556ff1e23e6c8692b28e3497a1b042))
* **jobs:** let a parsed invoice be opened from its job page ([a7495ec](https://github.com/MGrin/scani-oss/commit/a7495ec123acf98f91441a2e833cf6449c231bb2))
* **logging:** correct prod log service labels; own env vars via config.ts loader ([16df0e1](https://github.com/MGrin/scani-oss/commit/16df0e161caf2a6a642dde4828e75557f380ead7))
* **logging:** prod service labels + config.ts env loader; sync CLAUDE.md layout ([699c6de](https://github.com/MGrin/scani-oss/commit/699c6deeb2c6bb7d13194e5241c3c37eee18fbfd))
* **logging:** render a string `error` field instead of `undefined:undefined` ([8cc1f26](https://github.com/MGrin/scani-oss/commit/8cc1f26287190e6c90ec6b517b02f73afab9f932))
* **N-1:** defeat bun --compile NODE_ENV build-time inlining ([5395dcb](https://github.com/MGrin/scani-oss/commit/5395dcb91b88a745c53ce29bc3818512cc1567ef))
* **N-1:** remove deprecated isProduction const, use isNodeEnvProduction() everywhere ([0faae56](https://github.com/MGrin/scani-oss/commit/0faae56fdf8c19dc4e025763d16ab16ade4a4dae))
* **N-2:** make every dev-compose host port env-overridable ([6c48131](https://github.com/MGrin/scani-oss/commit/6c481319f64732fb28f878beb07836bfdc69d4c7))
* **N-3:** add dev:worker / dev:data-provider scripts, fix PORT collision ([695e8d6](https://github.com/MGrin/scani-oss/commit/695e8d6236b1d522be11de765945a8fabb092394))
* **N-6:** slim scani/migrate image via bun --compile ([bb43b63](https://github.com/MGrin/scani-oss/commit/bb43b6380423508dc285c392f57348924438c761))
* **N-7:** unify api Dockerfile port to 3001 + /readyz healthcheck ([30b15a0](https://github.com/MGrin/scani-oss/commit/30b15a0f10145c4d677ef1f76f20881d36985281))
* **observability:** stop Sentry floods from empty exchange links and bot 404s ([9087dc1](https://github.com/MGrin/scani-oss/commit/9087dc1f28c844e15ba9cc57e403485779a684c0))
* **observability:** stop Sentry floods from empty exchange links and bot 404s ([95e03ef](https://github.com/MGrin/scani-oss/commit/95e03ef91aead2d7695bbb50acb4a0ec301e51f4))
* **payments:** keep settled occurrences on the schedule when it moves ([eda76f3](https://github.com/MGrin/scani-oss/commit/eda76f377ea04cb7f78ea301ce0f96db49a13d60))
* **payments:** read the extraction by id, and narrow its text columns ([820330d](https://github.com/MGrin/scani-oss/commit/820330dc73220d8ca178aa44323988b46434046a))
* **payments:** rewrite every derived row on a schedule change ([bba94cb](https://github.com/MGrin/scani-oss/commit/bba94cbdf6d97ab31061a646787885b4386fe114))
* **payments:** say how many payments exist, not just what's due ([e84dc6a](https://github.com/MGrin/scani-oss/commit/e84dc6aafbf16ccdada339e7ac5ce0e38de29f6f))
* **pnl:** cover Binance Funding + P2P, realize PnL on unlinked exits ([5453982](https://github.com/MGrin/scani-oss/commit/54539826700dacb29edd8fedbcecf912e580c0b1))
* post-OSS-readiness-audit blockers (X-1, X-4) ([d8ed7a4](https://github.com/MGrin/scani-oss/commit/d8ed7a495e070a07b6925b0d0697fe952c892cc8))
* **pricing:** value non-base cash through the price graph (SC-505) ([4df4e1e](https://github.com/MGrin/scani-oss/commit/4df4e1eb4e433e385d9cd13722d14855ad22993c))
* **pricing:** value non-base cash through the price graph (SC-505) ([f432553](https://github.com/MGrin/scani-oss/commit/f4325536613a3a1bd197bb7995ca8b6028e73bb5))
* **providers:** a refusal must not read as an empty wallet ([3928f22](https://github.com/MGrin/scani-oss/commit/3928f2247c9fcd8a7f94b21721e3be3d1c4de2c6))
* **providers:** a refusal must not read as an empty wallet ([34e0fcd](https://github.com/MGrin/scani-oss/commit/34e0fcd0e1bb377313691d4db9dc26aae3ccf348))
* **providers:** drop IBKR short positions and margin-debt cash from balances ([3e578d5](https://github.com/MGrin/scani-oss/commit/3e578d588fbd31584fca0e3c94913c8cdb135638))
* **providers:** drop IBKR short positions and margin-debt cash from balances ([b1a903b](https://github.com/MGrin/scani-oss/commit/b1a903b6781e5113290f4e839c16df3be77d5ae5))
* **providers:** send a scanned PDF as a file part, not an image part ([90ec17d](https://github.com/MGrin/scani-oss/commit/90ec17dfbad9738254460ae77b63073a8eff0daa))
* **providers:** send the request shape gpt-5.6-luna actually accepts ([84f0218](https://github.com/MGrin/scani-oss/commit/84f02185e38d1d8b17cf6aa5975e58d285f5afd7))
* **publish:** refuse to publish images from anything but the scani-oss checkout ([8bf9728](https://github.com/MGrin/scani-oss/commit/8bf97289b6565a204f036ce9c704c8654c4f21cc))
* **publish:** refuse to publish images from anything but the scani-oss checkout ([fe1de4c](https://github.com/MGrin/scani-oss/commit/fe1de4cf6289b61acfa84bf6b2ace38f91f8b0ee))
* **queue:** bound queue.add so a dead Redis fails the enqueue instead of hanging (SC-523) ([3245e9a](https://github.com/MGrin/scani-oss/commit/3245e9aef6fa820352b590725f0a83d7bc5b1ad8))
* **queue:** bound queue.add so a dead Redis fails the enqueue instead of hanging (SC-523) ([3f0414d](https://github.com/MGrin/scani-oss/commit/3f0414dba918eb161aaed6819746953558cf6652))
* **queue:** give repeatable jobs attempts+backoff so transient DB drops don't dead-letter ([6f70ea8](https://github.com/MGrin/scani-oss/commit/6f70ea85d7490778811258d836918ec261865cf6))
* **queue:** make the queue-schema migration concurrency-safe (SC-518) ([37632d4](https://github.com/MGrin/scani-oss/commit/37632d4069d697e94b536f2c880edcb1ed8c32a4))
* **queue:** make the queue-schema migration concurrency-safe (SC-518) ([4cbb419](https://github.com/MGrin/scani-oss/commit/4cbb419431dfa26e1b44f46990886390e08d05c1))
* **rate-limiter:** bound the Redis waits so an outage cannot hang a caller ([bcacc12](https://github.com/MGrin/scani-oss/commit/bcacc12fdd330faf042e98d018e4b9d860f3f59a))
* **redis:** bound every Redis await on the api request path (SC-522) ([dd17ad1](https://github.com/MGrin/scani-oss/commit/dd17ad15482804feba0d57036abd5e5a1ac7aca4))
* **redis:** bound every Redis await on the api request path (SC-522) ([9ddd399](https://github.com/MGrin/scani-oss/commit/9ddd39960cd6ef2df3f61e983a0a20ef78dfa12c))
* **returns:** stop the opening anchor inventing a contribution, and stop one day absorbing ten weeks ([9ec00bf](https://github.com/MGrin/scani-oss/commit/9ec00bf843cce6daa20ba55e9669b784859cb5af))
* **security:** bound regex quantifiers to close polynomial-redos alerts ([ce1a30d](https://github.com/MGrin/scani-oss/commit/ce1a30d97b9d885028e6ce684e0853585fc29f7f))
* **security:** bound regex quantifiers to close polynomial-redos alerts ([7d6e988](https://github.com/MGrin/scani-oss/commit/7d6e98802c9349f3e6353f839158d151023f78d3))
* **security:** explicit scrypt params N=2^15 (M6) ([5030e72](https://github.com/MGrin/scani-oss/commit/5030e726e1515cbc0112aaeb46d70e1282067b1d))
* **security:** make the two flagged ReDoS regexes linear ([1edb332](https://github.com/MGrin/scani-oss/commit/1edb33286d935f3be4a57e3bcf13faf47288dd69))
* **security:** make the two flagged ReDoS regexes linear ([25aeb3d](https://github.com/MGrin/scani-oss/commit/25aeb3ded02f1693c358e49850f8b16d420b11d4))
* **self-host:** one command from an empty directory, and images that boot ([302ff30](https://github.com/MGrin/scani-oss/commit/302ff304e214813d3c3dd7c42412a9455f41a43c))
* **self-host:** one command from an empty directory, and images that boot ([9be2d25](https://github.com/MGrin/scani-oss/commit/9be2d252256318b5a664a0c9c059cd04a4382be7))
* **self-host:** refuse a re-run that would diverge from an existing install ([7d3082b](https://github.com/MGrin/scani-oss/commit/7d3082bf4a77a42dc57fc99d17a53f901faa021b))
* **self-host:** refuse a re-run that would diverge from an existing install (SC-479) ([5ffaf1c](https://github.com/MGrin/scani-oss/commit/5ffaf1ca95ad8d4e3f7ca7ff8b489c6c7149d8bc))
* **self-host:** SERVICE_NAME must be the spelling the published images expect ([95d7890](https://github.com/MGrin/scani-oss/commit/95d7890eea8cbd33213c43868c5f7bb98fcb9ea9))
* **self-host:** SERVICE_NAME must be the spelling the published images expect ([5d7acd1](https://github.com/MGrin/scani-oss/commit/5d7acd10bbb2430555e1a3e2988e493b1d7adb14))
* **shared:** en-DE date separator is CLDR data, not a property of this code ([73959ff](https://github.com/MGrin/scani-oss/commit/73959ff9866c53dc9e38c9982462ecfbf5425d63))
* **shared:** remove duplicate @scani/shared/utils/encryption module (H4) ([51b39db](https://github.com/MGrin/scani-oss/commit/51b39dbbc69399669c3c2c5dc8306cd223779df7))
* **sync:** select sync institutions via registry capability, not name list ([c72ff1f](https://github.com/MGrin/scani-oss/commit/c72ff1f4b9b41f97b4be28413b1feac2e7ccece8))
* **test:** scope root bun test to backend+frontend, exclude apps/e2e ([e1aab59](https://github.com/MGrin/scani-oss/commit/e1aab59c031c38245f771890a459f831bfe6d609))
* treat empty-string SENTRY_DSN / optional URL env vars as unset ([d29495d](https://github.com/MGrin/scani-oss/commit/d29495de81f05e2809eef41466e7b46f5dc2f2e5))
* treat empty-string SENTRY_DSN / optional URL env vars as unset ([a0e8565](https://github.com/MGrin/scani-oss/commit/a0e85656136b034260e819adc3ddf9af46664a13))
* **ui:** make PWA detection SSR-safe in PullToRefresh ([a1783d1](https://github.com/MGrin/scani-oss/commit/a1783d1b7437114c889978b3d0be9c125640fe34))
* **ui:** make PWA detection SSR-safe in PullToRefresh ([acb569c](https://github.com/MGrin/scani-oss/commit/acb569ce57fbd75ea8a4ed3f8abb3ad9e84180bc))
* unbounded DNS lookup reachable from user input; proxy institution favicons (SC-208) ([dcf1589](https://github.com/MGrin/scani-oss/commit/dcf1589d2c5ef0ee65eac874a87ae0b1ac63aa5c))
* **visual:** match the mark on every deployment the comment claims (SC-208) ([4c5bbae](https://github.com/MGrin/scani-oss/commit/4c5bbaef4d090d3570823c031a80c7212ce4061f))
* **worktree:** honour a &lt;SERVICE&gt;_HOST_PORT the environment already set ([8e5e07f](https://github.com/MGrin/scani-oss/commit/8e5e07faaed5f06b638815a7001ea2f7af9a6dec))
* **worktree:** honour a &lt;SERVICE&gt;_HOST_PORT the environment already set (SC-500) ([ee29f66](https://github.com/MGrin/scani-oss/commit/ee29f66b9ad77863380b142d210bc3862b1c322d))
* **X-1:** use Bun.env to defeat compile-time NODE_ENV substitution ([bae8eaa](https://github.com/MGrin/scani-oss/commit/bae8eaafec11746fc98fd90e4de7f1ef202a78d7))


### Performance Improvements

* **token-prices:** DISTINCT ON latest-price lookup to avoid full scans ([f8c6734](https://github.com/MGrin/scani-oss/commit/f8c6734052df9eafb180974d61a37d54b1bf048e))


### Miscellaneous Chores

* release as 0.4.0 ([ebef313](https://github.com/MGrin/scani-oss/commit/ebef31325380585b7f4b953401eeee6b13beb3d1))

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
