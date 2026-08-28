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

## [0.34.1](https://github.com/MGrin/scani-oss/compare/v0.34.0...v0.34.1) (2026-08-28)


### Bug Fixes

* **app:** every surface that shows a token name shows the reader's ([14336fb](https://github.com/MGrin/scani-oss/commit/14336fb969ce5c4c4264a3d44fb9fff4d7b08478))
* **docs:** serve robots.txt, and link the llms-full.txt we publish ([9be0ffb](https://github.com/MGrin/scani-oss/commit/9be0ffb99beef97cb8419796d7f2613f7e29a1be))
* **docs:** type-check the docs tests without dropping astro check ([df88601](https://github.com/MGrin/scani-oss/commit/df8860193f065810ad20c99b69e38c0a864f1f51))

## [0.34.0](https://github.com/MGrin/scani-oss/compare/v0.33.0...v0.34.0) (2026-08-28)


### Features

* **app:** translate the token type name instead of rendering Postgres prose ([aeaf8be](https://github.com/MGrin/scani-oss/commit/aeaf8be0c0feb13f0e6ad50fedd03752b2b5e839))
* **data-provider:** report the hourly request limit a key is subject to ([6193053](https://github.com/MGrin/scani-oss/commit/6193053c06b8281aea9c730ec7b9383d8b1691b3))


### Bug Fixes

* **app:** a fiat holding shows its currency name in the reader's language ([bee9c4b](https://github.com/MGrin/scani-oss/commit/bee9c4bd961d8251c43d75cc93388df2759783e1))
* **app:** account for estimated bills above the upcoming feed ([89e04e8](https://github.com/MGrin/scani-oss/commit/89e04e87648f3d1b8f71ac287c7e7e0a354c933e))
* **app:** the overdue tile leaves out estimates too, and now says so ([0954d25](https://github.com/MGrin/scani-oss/commit/0954d2562678c7281971fcd776df11feeb2014bd))
* **hooks:** a pre-push hook, because cherry-picks reach the mirror unchecked ([0ed8b23](https://github.com/MGrin/scani-oss/commit/0ed8b235ae97cfad10a3a09b9f96d73730aa5049))
* **hooks:** the refusal printed advice a pusher cannot follow ([c9172f6](https://github.com/MGrin/scani-oss/commit/c9172f6d380932c255add8a42abb8c820e95e10f))

## [0.33.0](https://github.com/MGrin/scani-oss/compare/v0.32.0...v0.33.0) (2026-08-28)


### Features

* **app:** ship Japanese on all three surfaces ([b4bd279](https://github.com/MGrin/scani-oss/commit/b4bd27998bc46a75e4a9329607d7a47efbf6d258))
* **portfolio:** report every disposal in a portfolio over a window ([6e69a53](https://github.com/MGrin/scani-oss/commit/6e69a53258550887c7972b7c21d841a356308138))


### Bug Fixes

* **email:** compare every leaf, not the ones over 24 characters ([88321a9](https://github.com/MGrin/scani-oss/commit/88321a96e1589605eaeb3b196f4b3c82797ab1a1))
* **i18n:** a French Vault is a savings goal, not a strongbox ([c8297ac](https://github.com/MGrin/scani-oss/commit/c8297ac8908baadb89ce7314caf02ea3987d05fc))
* **money:** show the history estimate on the upcoming feed, marked ([8aae30f](https://github.com/MGrin/scani-oss/commit/8aae30f3603dfa66146a15770e6a212c3bf89c15))

## [0.32.0](https://github.com/MGrin/scani-oss/compare/v0.31.0...v0.32.0) (2026-08-28)


### Features

* **app:** ship European Portuguese on all three surfaces ([712ce1f](https://github.com/MGrin/scani-oss/commit/712ce1f6bacaaa33dce7c20f4216f908d654631d))

## [0.31.0](https://github.com/MGrin/scani-oss/compare/v0.30.0...v0.31.0) (2026-08-28)


### Features

* **app:** ship Spanish, complete rather than started ([bd1cd0f](https://github.com/MGrin/scani-oss/commit/bd1cd0fc5588a4ab174eb7a17ceb37a030a9abff))
* **payments:** offer the last settled amount as an estimate for variable payments ([0329444](https://github.com/MGrin/scani-oss/commit/0329444ab9f6f0020588af2c858f7cfedd2aa57e))

## [0.30.0](https://github.com/MGrin/scani-oss/compare/v0.29.0...v0.30.0) (2026-08-28)


### Features

* **app:** ship French, complete rather than started ([6ea577a](https://github.com/MGrin/scani-oss/commit/6ea577ad0d6ea31e1415995c713a367b5ae7c7f5))
* **email:** the French letter, and a leak guard that can see it ([bd66c6c](https://github.com/MGrin/scani-oss/commit/bd66c6c5e33eb8b3990f2777f60faae89d9959a1))
* **pdf:** bundle Han faces so CJK statements stop rendering [?] ([39a3e6a](https://github.com/MGrin/scani-oss/commit/39a3e6aa9ee9f3479d81d9c8f6246fb49f4af5b4))


### Bug Fixes

* **repo:** ignore editor-local state, which a tracked sibling did not cover ([1ad16a9](https://github.com/MGrin/scani-oss/commit/1ad16a9d50a4ec2678d30fc13d17e1273d04dbfe))
* **repo:** make agent scratch uncommittable in every checkout ([2583402](https://github.com/MGrin/scani-oss/commit/2583402746887e9b4b093516eb1e2c76eb782772))
* **scripts:** a git that could not run is UNKNOWN, never a clean index ([35fdaa9](https://github.com/MGrin/scani-oss/commit/35fdaa96527548e7ab3307a348d52546ea8c57c0))
* **scripts:** a git that failed is UNKNOWN, never a clean tree ([00f4ef6](https://github.com/MGrin/scani-oss/commit/00f4ef6bc8c67071ae637790f9da464eebc08933))
* **scripts:** drop an export this repo has no caller for ([5775f87](https://github.com/MGrin/scani-oss/commit/5775f87de2b10297b1e2636ff095034b8a7fa807))
* **scripts:** refuse a mutation whose new content changes nothing ([34e3022](https://github.com/MGrin/scani-oss/commit/34e3022417c5ec32a52f0877199e960d987277ae))
* **scripts:** the census printed a claim about an extension the repo lacks ([c4cedcc](https://github.com/MGrin/scani-oss/commit/c4cedccf0359046fa9a3b5bf8140522dc30167cf))
* **scripts:** the tRPC census scanned 0 of the files directly under scripts/ ([3435634](https://github.com/MGrin/scani-oss/commit/3435634840fd74c8d659ab2ab4e2b32cdc0a03d0))
* **tests:** a // line comment cannot open a comment block ([d61357d](https://github.com/MGrin/scani-oss/commit/d61357dba6b52e13c2835724139f8474a5fcad4d))
* **ui:** mirror the three animations dir cannot mirror ([048671b](https://github.com/MGrin/scani-oss/commit/048671b65978bff4b80943ed4e8837c88c93b35e))
* **ui:** the rtl cascade guard was checking the wrong pairs ([f812ad4](https://github.com/MGrin/scani-oss/commit/f812ad4a37b360c4d165be06ef78611ad274697f))
* **v3:** two call sites formatted from the device, not the chosen language ([941cf25](https://github.com/MGrin/scani-oss/commit/941cf25b90d8b01ef082f10c84555f1fca12aee4))

## [0.29.0](https://github.com/MGrin/scani-oss/compare/v0.28.0...v0.29.0) (2026-08-28)


### Features

* **ui:** mirror v3 and the design system under dir="rtl" ([f28ebe2](https://github.com/MGrin/scani-oss/commit/f28ebe2150b77b846d01b91193ed27312b16e5da))


### Bug Fixes

* **ui:** mirror the Switch thumb and pin why rtl: wins ([57dd92a](https://github.com/MGrin/scani-oss/commit/57dd92a5535a3cb8f17d218b7412a437c22a8809))

## [0.28.0](https://github.com/MGrin/scani-oss/compare/v0.27.0...v0.28.0) (2026-08-28)


### Features

* **app:** offer closed positions on the wallet review card ([cca9338](https://github.com/MGrin/scani-oss/commit/cca93388709655be481d7eb9f8114176e2e9145a))
* **providers:** name the positions a wallet traded and no longer holds ([24ba238](https://github.com/MGrin/scani-oss/commit/24ba238a063213280bece6265f5ded0980854942))

## [0.27.0](https://github.com/MGrin/scani-oss/compare/v0.26.0...v0.27.0) (2026-08-27)


### Features

* **scripts:** report the api procedures that have never been called ([e2982af](https://github.com/MGrin/scani-oss/commit/e2982af8ce79e0ba5873fee76aa9b6af9e8dde8e))


### Bug Fixes

* **api:** put every tRPC call on the Sentry performance trace ([5169144](https://github.com/MGrin/scani-oss/commit/5169144c348f455e9a32ae7c5294e34a7023eb3c))
* **scripts:** say in the output that the no-caller list is a ceiling ([bf6f5c1](https://github.com/MGrin/scani-oss/commit/bf6f5c17b8a00841acfceabb52d467c98fb8a4e0))

## [0.26.0](https://github.com/MGrin/scani-oss/compare/v0.25.0...v0.26.0) (2026-08-27)


### Features

* **api:** record which tRPC procedures anything still calls ([600ebac](https://github.com/MGrin/scani-oss/commit/600ebac0874721311a0e3de91a69452986dcc765))
* **db:** date the procedure-call record with first_seen_at ([c1c18bb](https://github.com/MGrin/scani-oss/commit/c1c18bb95d6eb4b5659539777e0fb81584ac323f))


### Bug Fixes

* **scripts:** normalise the release-notes discriminator to UTC ([600ebac](https://github.com/MGrin/scani-oss/commit/600ebac0874721311a0e3de91a69452986dcc765))

## [0.25.0](https://github.com/MGrin/scani-oss/compare/v0.24.1...v0.25.0) (2026-08-27)


### Features

* **scripts:** census tRPC procedure callers in both call forms ([1570c96](https://github.com/MGrin/scani-oss/commit/1570c96ed1dc3daa18b9e113726af76ecf9206cf))


### Bug Fixes

* **api:** let the woff declaration reach any project that compiles fonts.ts ([1182635](https://github.com/MGrin/scani-oss/commit/1182635767ef3595762c95ca3eb5c3db47d72cae))
* **scripts:** refuse a killed docs:check spawn instead of returning zeros ([be012d9](https://github.com/MGrin/scani-oss/commit/be012d92ae662e1a348847a6dc43c890407f10e4))
* **scripts:** repoint the budget census at the shared docs:check runner ([79a8376](https://github.com/MGrin/scani-oss/commit/79a8376e6939a807b0b5133c77a38ce69a67abb9))

## [0.24.1](https://github.com/MGrin/scani-oss/compare/v0.24.0...v0.24.1) (2026-08-27)


### Bug Fixes

* **oss-guards:** stop reading a dead git call as a determinate answer ([40adbc8](https://github.com/MGrin/scani-oss/commit/40adbc83dab9f843a1a999d4416eb90f2bf1f339))

## [0.24.0](https://github.com/MGrin/scani-oss/compare/v0.23.1...v0.24.0) (2026-08-27)


### Features

* **scripts:** group the unparseable notice by whether a sibling covers it ([18b18e0](https://github.com/MGrin/scani-oss/commit/18b18e0a43043428e5a403e91d06e7d26f55b52a))


### Bug Fixes

* **docs:** say that knip gates exports and types, which it has since SC-558 ([10ddddb](https://github.com/MGrin/scani-oss/commit/10ddddbf52270dd76e9cd7d7c60c591557facb9b))
* **release:** the duplication caveat holds only if the whole branch is behind ([8c9ed1b](https://github.com/MGrin/scani-oss/commit/8c9ed1b98a85d949f3e4fe16fac9989b64d9d188))

## [0.23.1](https://github.com/MGrin/scani-oss/compare/v0.23.0...v0.23.1) (2026-08-27)


### Bug Fixes

* **db:** stop telling every reader to run one deployment's script ([ea81ca6](https://github.com/MGrin/scani-oss/commit/ea81ca6fd84506bf9a227e7a1e888fc245f2fdf9))
* **dev:** declare the dev:api script the docs prescribe ([75e83b8](https://github.com/MGrin/scani-oss/commit/75e83b846919b5e3e5ed8257c0784d0732ec2205))
* **e2e:** name the docker escape hatch, and document the vars it needs ([08d5613](https://github.com/MGrin/scani-oss/commit/08d5613fa93b7a3fea193116e6b1d220a1b5c104))
* **e2e:** resolve the stack's database instead of assuming `scani` ([5c8ec6d](https://github.com/MGrin/scani-oss/commit/5c8ec6dbe4d3df346bcc6a1600b527c374eb02ad))
* give subprocess tests a budget bunfig could never supply ([#288](https://github.com/MGrin/scani-oss/issues/288)) ([d7af10f](https://github.com/MGrin/scani-oss/commit/d7af10f1af15b6885c069f757c96c45ee9f8065e))
* **guards:** see a prescribed script written without run ([e2ed3d4](https://github.com/MGrin/scani-oss/commit/e2ed3d4bc288c9aa189f1f2c0a59f4762969970b))

## [0.23.0](https://github.com/MGrin/scani-oss/compare/v0.22.0...v0.23.0) (2026-08-27)


### Features

* **dev-stack:** start only what a gate uses, with --infra-only ([4699301](https://github.com/MGrin/scani-oss/commit/4699301770b2a498e65b91f725f72e73647fc0eb))
* **oss-guards:** let the branch classifier answer about a ref, not just HEAD ([3780923](https://github.com/MGrin/scani-oss/commit/3780923c564432ff4b67121779c12bdcf7374963))
* **scripts:** say the pr-ready check is not available here ([b0ffceb](https://github.com/MGrin/scani-oss/commit/b0ffceb3ba580b794a47ae0b40a29f047cf70bbe))


### Bug Fixes

* **dev-stack:** let --wait supervise only what is meant to stay up ([65d0e00](https://github.com/MGrin/scani-oss/commit/65d0e00de165029b5c05e972535f81e84c2b398c))
* **hooks:** stop advising a bypass that would commit conflict markers ([8df9ec6](https://github.com/MGrin/scani-oss/commit/8df9ec63a8db5b14fb006af2256a09f124c6f1d5))
* **scripts:** bind every file that states the published image set ([b7f2fdd](https://github.com/MGrin/scani-oss/commit/b7f2fdd2d3cb0435ccd8494628fcb5d5ff851e59))
* **scripts:** bind the prose that states the published image set ([90eeb01](https://github.com/MGrin/scani-oss/commit/90eeb0178d63f4ee05c80a5f0fb5b764aaa27529))
* **scripts:** do not read the workspace package @scani/db as an image ([90eeb01](https://github.com/MGrin/scani-oss/commit/90eeb0178d63f4ee05c80a5f0fb5b764aaa27529))
* **scripts:** stop the image-set test naming a private infra path ([8885895](https://github.com/MGrin/scani-oss/commit/8885895355f48498189c68997ff106d64f6c4953))
* **tests:** reset the stub value beforeEach, not just the counters beside it ([c84195d](https://github.com/MGrin/scani-oss/commit/c84195d6999bd7c612097833d54781107a16237e))

## [0.22.0](https://github.com/MGrin/scani-oss/compare/v0.21.0...v0.22.0) (2026-08-26)


### Features

* report compose stacks that have no checkout behind them ([#267](https://github.com/MGrin/scani-oss/issues/267)) ([d4399a6](https://github.com/MGrin/scani-oss/commit/d4399a6f1a3d699329fa0bac7a54850ee9f70909))


### Bug Fixes

* **scripts:** make the NUL guard answer about the repo, not the cwd ([193b56f](https://github.com/MGrin/scani-oss/commit/193b56f1470cbd306da02d7cf10e49b47edee4ca))
* **scripts:** refuse a literal NUL byte in a tracked source file ([cf29a1e](https://github.com/MGrin/scani-oss/commit/cf29a1e5d904733ca0d03827778573618a6b890d))
* **tests:** make in-repo test fixtures uncommittable ([1942376](https://github.com/MGrin/scani-oss/commit/19423765309d72ec34a3ca2bbcc43be72a7db438))

## [0.21.0](https://github.com/MGrin/scani-oss/compare/v0.20.0...v0.21.0) (2026-08-26)


### Features

* **app:** let the user confirm or override the measured drain ([fa63441](https://github.com/MGrin/scani-oss/commit/fa63441afdc0ea07ff3c70037b218326e724cdd5))
* **money:** say who classified the money the burn is made of ([51879b3](https://github.com/MGrin/scani-oss/commit/51879b3406bf2d9f997f9be15fd61e41cb86e301))


### Bug Fixes

* **api:** make input strictness reach nested and refined schemas ([2c688e8](https://github.com/MGrin/scani-oss/commit/2c688e8f3f1ae94d80aaeae6585bb2b217afdc4d))
* **api:** project the current user instead of returning the row ([bc2bf5c](https://github.com/MGrin/scani-oss/commit/bc2bf5cd017c4ffcce644b5a98339bb8f14afb53))
* **api:** refuse input parameters no schema declares (SC-675) ([e3655d8](https://github.com/MGrin/scani-oss/commit/e3655d87f50b2b1a8d852543535e49acac41aaa5))
* **api:** refuse undeclared parameters on a discriminated-union input ([c40f83b](https://github.com/MGrin/scani-oss/commit/c40f83b3d8ecddbe335b7b46c78c25126eb6221b))
* **app:** a burn-provenance share under half a percent printed 0% ([d999e15](https://github.com/MGrin/scani-oss/commit/d999e1542fc8692433f1817f7bc1a523cbc127d7))
* **app:** grey out a zero override instead of letting it 400 ([5a85c84](https://github.com/MGrin/scani-oss/commit/5a85c84378cb7083dfb2b29d9ff530191012b7f4))
* **app:** render no affordance rather than throwing on an older api ([70708fc](https://github.com/MGrin/scani-oss/commit/70708fc60613ef42e8740e1e8feef71ec606889a))
* **dev-stack:** wait for healthchecks on up, and say what was verified ([caecf03](https://github.com/MGrin/scani-oss/commit/caecf034cc18fab438b69582d3ac84a7e73f59ba))
* **docker:** read PORT in the backend healthchecks instead of hardcoding it ([7799c84](https://github.com/MGrin/scani-oss/commit/7799c8485e20a622e89cb2a18fda1eb45170cb22))
* invent the owner's name in the payment-description fixtures ([3fb35bd](https://github.com/MGrin/scani-oss/commit/3fb35bdfedfc670c3779e2bf80ef37f3f0191d9c))
* invent the second payee in the payment-description fixtures ([80aa62b](https://github.com/MGrin/scani-oss/commit/80aa62b475aeafff6a51cbb51fa052bf1f7ebe8a))
* use an invented address pair in the transfer-rule fixtures ([e1f9b5e](https://github.com/MGrin/scani-oss/commit/e1f9b5ef4aae13a68306842242e2296a49a5464d))
* use invented fixtures for the observed-burn figures ([17f2339](https://github.com/MGrin/scani-oss/commit/17f233995f48eff9ef200662760cb201aa91acff))

## [0.20.0](https://github.com/MGrin/scani-oss/compare/v0.19.0...v0.20.0) (2026-08-26)


### Features

* **db:** the user may override or confirm the measured monthly drain ([4fe6fd6](https://github.com/MGrin/scani-oss/commit/4fe6fd6fba4b8a4d061c900c5fd0f7cb7813dafa))


### Bug Fixes

* name the statistic, and print the median beside it ([0789bc0](https://github.com/MGrin/scani-oss/commit/0789bc0074080c9a2918f83a385962ecf1c0f3e9))
* **release:** say that one override block may carry several messages ([0789bc0](https://github.com/MGrin/scani-oss/commit/0789bc0074080c9a2918f83a385962ecf1c0f3e9))
* **review:** decode who answered from the source column, never the timestamp ([bf6ce3a](https://github.com/MGrin/scani-oss/commit/bf6ce3ab93783dd2c50fb65881fd53c5aec156f5))
* the forecast page answers from observed burn, like the home line ([0789bc0](https://github.com/MGrin/scani-oss/commit/0789bc0074080c9a2918f83a385962ecf1c0f3e9))

## [0.19.0](https://github.com/MGrin/scani-oss/compare/v0.18.0...v0.19.0) (2026-08-26)


### Features

* **domain:** the valuation chain takes a database transaction ([04b604c](https://github.com/MGrin/scani-oss/commit/04b604ca0b3d894d2ea081caceb7029cb939360d))
* **entities:** separate personal and company assets with an ownership boundary ([28d437a](https://github.com/MGrin/scani-oss/commit/28d437acebe4bc0964804e2361dfe0e38993ce77))
* **money:** cashflow forecast and runway from recurring payments ([3f0031d](https://github.com/MGrin/scani-oss/commit/3f0031deda804a3ecfca19af3d2a4dd08a5eed29))
* **oss:** port the three shared guards the mirror was missing ([91f1624](https://github.com/MGrin/scani-oss/commit/91f1624da8ca7ab3f9ea2078a70ae9215b024b87))
* **payments:** measure burn as money leaving the tracked perimeter ([fc0bdb0](https://github.com/MGrin/scani-oss/commit/fc0bdb0d6e91322d54889049951144a42f2403da))


### Bug Fixes

* **app:** make record-movement a page with a searched holding field ([3554b91](https://github.com/MGrin/scani-oss/commit/3554b914639035b7b4a6632ccbb25502e6f73164))
* **db:** decide read-only from the entry point's directory, not its name ([35b00dd](https://github.com/MGrin/scani-oss/commit/35b00dd0e22e1f419cb50a7312ca82a25e72ee1c))
* **dev-stack:** `down` removes orphans, and says what it verified ([616989f](https://github.com/MGrin/scani-oss/commit/616989fa9e0a964508b9179e2adfdc4b65df7e8e))
* **docker:** keep every per-app .env out of the build context ([4bdfcb9](https://github.com/MGrin/scani-oss/commit/4bdfcb97530b30753acc774fd38e702203c80971))
* **domain:** export the transaction-sources subpath the file already is ([2ce02ad](https://github.com/MGrin/scani-oss/commit/2ce02ad52993e22a291fb6b82da414bdc21fcb95))
* **holdings:** a balance below zero says why, instead of reading as theft ([7b339db](https://github.com/MGrin/scani-oss/commit/7b339db04590e267f72f823adf891e6a8d9d6bb5))
* **holdings:** an internal answer records the opening of the holding it creates ([9a20a2e](https://github.com/MGrin/scani-oss/commit/9a20a2ec4d60501efcdb995a41c07f4bdb9458cc))
* **holdings:** move both anchors when the owner declares a transfer ([#210](https://github.com/MGrin/scani-oss/issues/210)) ([92266e5](https://github.com/MGrin/scani-oss/commit/92266e5b0c7412928affc4c2f97a49bdf2ce1945))
* **http-fetch:** a quadratic regex on attacker-controlled markup — shipped in v0.15.0 (SC-208) ([6b08be4](https://github.com/MGrin/scani-oss/commit/6b08be435beeb0242e87acf7a5ec0c98ac4612c9))
* **i18n:** drop the orphan destinationScope key from the v3 locales ([5f4810a](https://github.com/MGrin/scani-oss/commit/5f4810af31cb02db1adcc3a0720f61e8df4b0db7))
* **knip:** deps:unused could not see 188 of 197 domain source files ([4a938ba](https://github.com/MGrin/scani-oss/commit/4a938ba6e9aab1d4693073a341403f1ceed1f799))
* **oss-guard:** count boundary markers by set difference, not by diff ([b799e82](https://github.com/MGrin/scani-oss/commit/b799e82e5a46ca6989d38b144617a11eb64177b0))
* **oss-guard:** decide boundness from the tree, not from descent ([7f53e9a](https://github.com/MGrin/scani-oss/commit/7f53e9a156a485693b8e965c8231c9c70c92ef63))
* **oss-guard:** weigh marker shares, not marker presence ([3cb1221](https://github.com/MGrin/scani-oss/commit/3cb1221a8455c06679559cb481e48424c46a3f9a))
* **oss:** a prescribed command has to resolve in this repo ([8993664](https://github.com/MGrin/scani-oss/commit/8993664b2133f0c8457404f19f17454e80422d6d))
* **oss:** name both causes of a missing release entry, and a recovery that does not duplicate (SC-621) ([fcb684e](https://github.com/MGrin/scani-oss/commit/fcb684e934ae1a5fce6f60f09c5c60736a9318f8))
* **oss:** refuse a pull-request body that would replace every commit message (SC-638) ([fbf42c4](https://github.com/MGrin/scani-oss/commit/fbf42c45a1e15a13b8c0c24f641aaf96d47d83bf))
* **oss:** restore the favicon wording a port adaptation depends on ([6349359](https://github.com/MGrin/scani-oss/commit/6349359689aadbbc01298630be569ab2f3535639))
* **oss:** scope OSS_ALLOW_NEW_FILES to new files (SC-639) ([b9b853f](https://github.com/MGrin/scani-oss/commit/b9b853fae76b097ff46d235985ecb2cba9e523e3))
* **oss:** the refusal messages name a command this repo ships ([62bb575](https://github.com/MGrin/scani-oss/commit/62bb5754e525e351caf24c84f59da79c0193b0b7))
* **payments:** make the runway line's committed share readable, and stop it linking to a page that contradicts it ([ee8c1ac](https://github.com/MGrin/scani-oss/commit/ee8c1aca74aee18d40a42c683406cb690bb53e8b))
* **payments:** roll the materialisation horizon on a schedule ([ec15c57](https://github.com/MGrin/scani-oss/commit/ec15c57c684fdced20805c7aa0e5f9ac8af610f8))
* **release-notes:** a fork PR gets a read-only token, so report via pull_request_target ([1ac79bc](https://github.com/MGrin/scani-oss/commit/1ac79bccbb8d0314c6a8097d37fc780671a4c45f))
* **release-notes:** report on an ordinary pull request so the check can be required ([1ac79bc](https://github.com/MGrin/scani-oss/commit/1ac79bccbb8d0314c6a8097d37fc780671a4c45f))
* **release-notes:** the dispatch control found two defects in its own workflow ([5eac264](https://github.com/MGrin/scani-oss/commit/5eac2645d3641d914916856dee13a8e9bad32573))
* **returns:** stop the opening anchor inventing a contribution, and stop one day absorbing ten weeks — shipped in v0.15.0 ([6b08be4](https://github.com/MGrin/scani-oss/commit/6b08be435beeb0242e87acf7a5ec0c98ac4612c9))
* **transfers:** reopening a declared transfer puts both balances back ([f5a30c0](https://github.com/MGrin/scani-oss/commit/f5a30c0a87aac3134739dbcd259dacfcbaf09c26))
* **transfers:** reopening an internal answer removes the holding it created ([612cfaf](https://github.com/MGrin/scani-oss/commit/612cfafad7b58bac1e2141872e960280156a7e02))
* **transfers:** the nightly matcher may not claim a row a person authored ([d16dc35](https://github.com/MGrin/scani-oss/commit/d16dc3585f7eacdb68ff1cd37ddbe7be6df286ab))
* **type-check:** compile scripts/, which no workspace covered ([1e9659c](https://github.com/MGrin/scani-oss/commit/1e9659cc82c3f1644a01ffa0cd00d4017f00b080))

## [0.18.0](https://github.com/MGrin/scani-oss/compare/v0.17.1...v0.18.0) (2026-08-25)


### Features

* **data-provider:** tell an explicitly-disabled cost control apart from an unset one (SC-582) ([#196](https://github.com/MGrin/scani-oss/issues/196)) ([a766740](https://github.com/MGrin/scani-oss/commit/a766740323081054dbd79a042c86f7626fdc09b5))
* **holdings:** record an inflow, outflow or transfer (SC-607) ([a6ee3cd](https://github.com/MGrin/scani-oss/commit/a6ee3cd16d3997ded5565cb943a6c61057720cdd))
* **oss:** add an advisory tier and make the guard prove it still works (SC-598) ([8b4da36](https://github.com/MGrin/scani-oss/commit/8b4da3639b6961eab858f8eae03abdd206c9f577))
* **oss:** refuse internal references in content bound for the public mirror (SC-598) ([7315db9](https://github.com/MGrin/scani-oss/commit/7315db9be6113c9276ae7976cfbf750959689042))
* **tokens:** give decimals a named authority, and NULL where none answered (SC-544) ([7614771](https://github.com/MGrin/scani-oss/commit/761477143324f3e2ddbadcb80f82c13d925fac93))


### Bug Fixes

* **cloud-api:** scope storage and email to internal keys ([c30588c](https://github.com/MGrin/scani-oss/commit/c30588cf511ffd49364701392fe3d61edec100d8))
* **docs:** stop the docs site linking to a repository readers cannot open (SC-589) ([ae3bcb3](https://github.com/MGrin/scani-oss/commit/ae3bcb30bee80a52fa7254b6e217f3e2c749a92e))
* **holdings:** a balance edit may only open a destination, not name one ([990be97](https://github.com/MGrin/scani-oss/commit/990be970a8fd6654317110a72823a4f14f5cb41d))
* **holdings:** an untouched date field means now, not the start of the day ([#207](https://github.com/MGrin/scani-oss/issues/207)) ([ab213bc](https://github.com/MGrin/scani-oss/commit/ab213bc347acc849f7c00e3910852a908dab5c28))
* **holdings:** cap the synthesized opening at the balance it must explain (SC-613) ([0397b73](https://github.com/MGrin/scani-oss/commit/0397b73d101e806dbcfba219bb9093027ada2482))
* **holdings:** one manual balance edit asks one question ([01b966a](https://github.com/MGrin/scani-oss/commit/01b966afaac311f6111be8a16e44b785a871bc74))
* **holdings:** stamp a declared transfer's outflow, not just group it (SC-607) ([15a415f](https://github.com/MGrin/scani-oss/commit/15a415f84e929c0465c79bf97d04aff03feeaef8))
* **hooks:** invoke the staged-fixture guard the pre-commit hook already ships (SC-605) ([3b73e3f](https://github.com/MGrin/scani-oss/commit/3b73e3f53ae8db4a9259d9f8fb10cb22a33a5721))
* **port-holder:** sample docker twice, and only when it timed out (SC-591) ([#197](https://github.com/MGrin/scani-oss/issues/197)) ([376ba0a](https://github.com/MGrin/scani-oss/commit/376ba0a536340c650b87e51d411cebf2a9eb652a))
* **providers:** delete OPENAI_VISION_MODEL rather than wire it up (SC-588) ([00e686c](https://github.com/MGrin/scani-oss/commit/00e686cabf73972d1752cbe813a31e5881504bfe))
* **queue:** name Postgres in the enqueue timeout and re-size the bound (SC-578) ([fc5cee2](https://github.com/MGrin/scani-oss/commit/fc5cee21eb7ae5752a426035c4e43c25840dc711))
* **tests:** journal tracked-source mutations so a killed run repairs itself (SC-601) ([4c504fd](https://github.com/MGrin/scani-oss/commit/4c504fd80576158908922f6cd5130b008236056d))
* **tests:** read the journal's target through ENOENT, not existsSync (SC-601) ([7e9d534](https://github.com/MGrin/scani-oss/commit/7e9d5341043f653487bdc9bb8787e0ef44d19ff2))
* **tests:** sweep a killed run's staged fixture before writing a new one (SC-596) ([05cfb70](https://github.com/MGrin/scani-oss/commit/05cfb704266210bed0e08299918f88d28639d84e))


### Performance Improvements

* **tests:** cut PnLQuality fixture from 35 round trips per test to 13 (SC-594) ([#198](https://github.com/MGrin/scani-oss/issues/198)) ([ab213bc](https://github.com/MGrin/scani-oss/commit/ab213bc347acc849f7c00e3910852a908dab5c28))

## [0.17.1](https://github.com/MGrin/scani-oss/compare/v0.17.0...v0.17.1) (2026-08-22)


### Bug Fixes

* **dev:** give each checkout its own stack, not the one next door (SC-497) ([83bb1dc](https://github.com/MGrin/scani-oss/commit/83bb1dcdc837ea74cec6415759dabde00c54ede4))
* **v3:** name the verb when a capture form's submit fails (SC-529) ([216245b](https://github.com/MGrin/scani-oss/commit/216245b3c341222ae9120dc819c82440c7664529))

## [0.17.0](https://github.com/MGrin/scani-oss/compare/v0.16.0...v0.17.0) (2026-08-22)


### Features

* **oss:** refuse a mirror-bound commit carrying private-only paths (SC-569) ([e28d6cc](https://github.com/MGrin/scani-oss/commit/e28d6ccaab75725726445ae1689c28cc11be7215))


### Bug Fixes

* **oss:** move orphanable ignore rules to the root as globs (SC-577) ([95f5fce](https://github.com/MGrin/scani-oss/commit/95f5fceeb6e0896a283b385ca966a501562bdfe7))
* **oss:** replace machine-specific paths in two test fixtures (SC-566) ([ba10ab9](https://github.com/MGrin/scani-oss/commit/ba10ab9d239d93f6df16034f9d08d7523ac6cddb))
* **v3:** make the balance-review card readable on a phone (SC-576) ([7c79fc0](https://github.com/MGrin/scani-oss/commit/7c79fc06dad9d3a86dbd87327d28351a1d086a3e))

## [0.16.0](https://github.com/MGrin/scani-oss/compare/v0.15.0...v0.16.0) (2026-08-22)


### Features

* **holdings:** let a pot be named after it exists (SC-564) ([ea4f2b5](https://github.com/MGrin/scani-oss/commit/ea4f2b5f8beea86c582516446c1e6f93456d307d))


### Bug Fixes

* **holdings:** reconcile hidden holdings in the user-wide pass (SC-502) ([42066e0](https://github.com/MGrin/scani-oss/commit/42066e08ca654853dbed477d994156f5bf20a582))
* **holdings:** send the balance whole, and say "&lt; 0.00000001" not "0" (SC-567) ([5a006ab](https://github.com/MGrin/scani-oss/commit/5a006abd19776d91fe4a12475810a8d64c5eddad))
* **holdings:** show the pot name in the desktop table too (SC-564) ([d21d588](https://github.com/MGrin/scani-oss/commit/d21d588979d2e0ba5382688c316578952b38575a))
* **holdings:** stop the balance editor destroying a dust balance (SC-567) ([5a006ab](https://github.com/MGrin/scani-oss/commit/5a006abd19776d91fe4a12475810a8d64c5eddad))
* **jobs:** stop telling a reader to check details that are not on the page (SC-554) ([5841793](https://github.com/MGrin/scani-oss/commit/5841793dacccfc2f6103499ecf265ce61f909e61))
* **self-host:** serve the nine security headers the nginx image never sent (SC-561) ([050fbc6](https://github.com/MGrin/scani-oss/commit/050fbc6304a5edec1660cd046877977783fe9010))

## [0.15.0](https://github.com/MGrin/scani-oss/compare/v0.14.1...v0.15.0) (2026-08-22)


### Features

* **docs:** derive docs:check lists from git, and add three checks (SC-170) ([b90e3a8](https://github.com/MGrin/scani-oss/commit/b90e3a8db29aaf12e69d9650329e2a74ce425de5))
* **holdings:** manual balance edits become transactions, not performance (SC-510) ([16d92bd](https://github.com/MGrin/scani-oss/commit/16d92bd8792403afedc5df4ca630f337ff4f4113))
* **icons:** proxy institution favicons instead of calling Google (SC-208) ([f64b376](https://github.com/MGrin/scani-oss/commit/f64b3764cc0e2f6e023f4360101a693e2133f253))
* **providers:** say at boot which providers came up without a key (SC-536) ([079d8d2](https://github.com/MGrin/scani-oss/commit/079d8d272c75e83050e91fa1cf65f199fc4e1f6f))
* **queue:** move BullMQ from Redis to the Postgres backend (SC-518) ([1c117c4](https://github.com/MGrin/scani-oss/commit/1c117c4ac8e9aafc8828bceca229166aeadfb873))
* **queue:** upgrade BullMQ 5.77.3 -&gt; 6.2.0, still on Redis (SC-518) ([7a33953](https://github.com/MGrin/scani-oss/commit/7a3395304ed4857bd8d87326695142707eb281fd))
* **review:** ask what an unexplained balance change was (SC-501) ([a50b3be](https://github.com/MGrin/scani-oss/commit/a50b3befa1f0c7abf51f55026b1fa6c50f445a1b))


### Bug Fixes

* **compose:** route migrate through db:migrate so the queue schema is created ([3b11e33](https://github.com/MGrin/scani-oss/commit/3b11e333511a9b247379b6eb9e2e21a15146ea1d))
* **deps:** deps:unused can see an unused file ([8c28d67](https://github.com/MGrin/scani-oss/commit/8c28d67fc9cf3b7331ce94c8ed75108b5bba36b8))
* **docker:** drop the bullmq SQL copy from data-provider — it has no queue ([25b7bb9](https://github.com/MGrin/scani-oss/commit/25b7bb911d1fda49e386cba5c7e328db7b803174))
* **docker:** reconcile docker-readmes against the published image set ([b9cdff4](https://github.com/MGrin/scani-oss/commit/b9cdff4802247d5395020b0d87386b66c73daa96))
* **docker:** ship BullMQ's Postgres SQL beside the compiled binary (SC-518) ([c29dc75](https://github.com/MGrin/scani-oss/commit/c29dc753a838de057ede46e80602f98308c5ce74))
* **docs:** a generated changelog entry is a quotation, not a claim (SC-556) ([ae39605](https://github.com/MGrin/scani-oss/commit/ae39605b956b6a516f46f668bc37ef0f2e83e260))
* **docs:** compile every .mdx page in docs:check ([9cc8960](https://github.com/MGrin/scani-oss/commit/9cc8960514f31610ff1ffe36929a953e7a9660fb))
* **docs:** keep the migrate description inside Docker Hub's 100-char cap ([ac1b64d](https://github.com/MGrin/scani-oss/commit/ac1b64d21f4bc5a83c54619960fa5bbb0fce8b16))
* **e2e:** a spec path handed to test:e2e is a path, not a project (SC-533) ([4bd8e4d](https://github.com/MGrin/scani-oss/commit/4bd8e4d2cf7e79474ce3cab43c739b9a9a78a978))
* **e2e:** let waitForJob outlive the test budget so its message can be printed (SC-498) ([28fd19a](https://github.com/MGrin/scani-oss/commit/28fd19a7025e5f7f678ee9790913f8b74127dd21))
* **http-fetch:** the DNS step was outside every timeout, on the OG path too (SC-208) ([fbe0ac0](https://github.com/MGrin/scani-oss/commit/fbe0ac0f0a7dcef0ad02ad9785dd6a0ac5250f91))
* **icons:** an unresolvable API base must be a letter tile, not a thrown render (SC-208) ([de95ea1](https://github.com/MGrin/scani-oss/commit/de95ea12cf24e92155390f8777ab033813d81834))
* **icons:** bound the whole icon resolve, not just its fetches (SC-208) ([39d3cbe](https://github.com/MGrin/scani-oss/commit/39d3cbe5dfbfe00dfc109d575cddb8bd9801298f))
* **jobs:** the owner sees only what somebody wrote for them (SC-551) ([b439a69](https://github.com/MGrin/scani-oss/commit/b439a691991c435bda91bc47b36ec2c8691c56dc))
* **migrate-image:** apply the queue schema, not just Drizzle (SC-535) ([7d16f67](https://github.com/MGrin/scani-oss/commit/7d16f6766d6a92f021839e364362ca7162c5fb8a))
* **queue:** bound queue.add so a dead Redis fails the enqueue instead of hanging (SC-523) ([3f0414d](https://github.com/MGrin/scani-oss/commit/3f0414dba918eb161aaed6819746953558cf6652))
* **queue:** make the queue-schema migration concurrency-safe (SC-518) ([4cbb419](https://github.com/MGrin/scani-oss/commit/4cbb419431dfa26e1b44f46990886390e08d05c1))
* **release:** bound the commit walk, or 0.15.0 comes out as 0.4.0 (SC-540) ([f7d2011](https://github.com/MGrin/scani-oss/commit/f7d20112790e4bc84dd4e3bce2823cd98c3378dd))
* **review:** three defects the browser found, that no check could (SC-501) ([8ffec73](https://github.com/MGrin/scani-oss/commit/8ffec7328714c7cbcefbe26cab3a84861cea72bd))
* **ui:** the mark comment points at a directory this repo does not have (SC-538) ([dc24713](https://github.com/MGrin/scani-oss/commit/dc24713f9fa27a57bdba07321b0738ef1d69fb2a))
* **v3:** name the unit on a holding's amount, and lead an account row to its holdings (SC-559, SC-560) ([d97ce8b](https://github.com/MGrin/scani-oss/commit/d97ce8b3ffce855f27bac7a4e9f9b1fb691050a7))
* **v3:** show the sentence somebody wrote, not "Unknown error" (SC-551) ([8c6f113](https://github.com/MGrin/scani-oss/commit/8c6f113be5e16aea2b846759b111dffdde22fa92))
* **visual:** match the mark on every deployment the comment claims (SC-208) ([4c5bbae](https://github.com/MGrin/scani-oss/commit/4c5bbaef4d090d3570823c031a80c7212ce4061f))
* **worker:** use the lock boot configures in both processors (SC-550) ([535b10e](https://github.com/MGrin/scani-oss/commit/535b10eba9dabe5e1cd3b23ae2c85442eb951940))
* **worktree:** a path that does not exist is not a checkout (SC-563) ([21e786f](https://github.com/MGrin/scani-oss/commit/21e786f42911260862eab6d9d2987cf9c24f7505))
* **worktree:** honour a &lt;SERVICE&gt;_HOST_PORT the environment already set (SC-500) ([ee29f66](https://github.com/MGrin/scani-oss/commit/ee29f66b9ad77863380b142d210bc3862b1c322d))

## [0.14.1](https://github.com/MGrin/scani-oss/commit/9ddd39960cd6ef2df3f61e983a0a20ef78dfa12c) (2026-08-21)

Published to Docker Hub by hand from `scripts/publish-images-local.sh`, built from
[`9ddd399`](https://github.com/MGrin/scani-oss/commit/9ddd39960cd6ef2df3f61e983a0a20ef78dfa12c).
There is no `v0.14.1` git tag and release-please did not cut this release, so it has no
generated entry above.

`release-please-config.json` carries `bootstrap-sha: 9ddd39960cd6…` — this release's build
commit — so the next generated section covers only commits *after* it, and does not
re-list what these three sections already record. Without that, release-please finds no
release matching the manifest version, drops its stopping point, and walks the entire
history (measured: 393 commits, and it picked up a `Release-As: 0.4.0` footer from
2026-05-25). The setting only binds while no tag matches the manifest, so it stops having
any effect once `v0.15.0` exists.

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
