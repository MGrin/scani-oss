# Changelog

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
