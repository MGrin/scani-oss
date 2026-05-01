# @scani/email

Transactional email — brand-aware templates plus three transport
implementations (Fastmail JMAP, SMTP, stdout) behind one abstract
`EmailService` class. Consumers inject `LocalEmailService` (or
`@scani/cloud-client`'s `EmailFacade` for cloud routing) and call
`sendMagicLink` / `sendVerificationEmail` / `sendOtp` — they never see
which transport is doing the work.

## Use case

Better-Auth flows: magic links, sign-up verifications, one-time codes.
Both the user-facing app (`apps/backend/api`) and the cloud-frontend
operator console (`apps/backend/data-provider`) use these — branded
differently per `EmailBrand` so end-users see "Scani" and operators see
"Scani Cloud".

## Architecture

```
                              EmailService (abstract)
                              │  high-level: sendMagicLink / sendVerificationEmail / sendOtp
                              │  low-level (public): send(message)
                              │  abstract: sendMessage(message)
                              ▼
        ┌────────────┬─────────────────┬──────────────────┬────────────────────────────┐
        │            │                 │                  │                            │
FastmailEmailService SmtpEmailService LoggingEmailService LocalEmailService            CloudEmailService*
   (JMAP)             (nodemailer)      (stdout fallback)  (@Service() — picks among   (in @scani/cloud-client —
                                                            the three above based on    routes via tRPC to the
                                                            env)                        data-provider's email.send)
```

`*CloudEmailService` lives in `@scani/cloud-client` (it depends on the
typed tRPC client). It's still an `EmailService` subclass — same surface,
different transport. `EmailFacade` (also in `@scani/cloud-client`) picks
between `CloudEmailService` (when `SCANI_CLOUD_URL` is set) and a
`LocalEmailService` (otherwise), exactly mirroring `StorageFacade`.

## Methods

| Method | Purpose |
|---|---|
| `sendMagicLink({ to, url, brand? })` | Renders the magic-link template and sends. Brand defaults to `SCANI_BRAND`. |
| `sendVerificationEmail({ to, url, brand? })` | Sign-up "confirm your email" template. |
| `sendOtp({ to, code, type, brand? })` | 6-digit code template. `type` switches the headline copy: `'sign-in' \| 'email-verification' \| 'forget-password' \| 'change-email'`. |
| `send(message)` | Bypass templating; ship a fully-rendered `EmailMessage`. Used by the data-provider's `email.send` tRPC route to relay payloads from cloud-routed callers. |

## Brands

`SCANI_BRAND` and `SCANI_CLOUD_BRAND` are exported as constants. Each
holds `appName`, `appUrl`, `marketingUrl`, `supportAddress`, `from`, plus
the small palette the layout HTML uses (`accent`, `bodyBg`, `cardBg`, …).
To brand-customize, pass a `brand` argument to the high-level method, or
build a custom `EmailBrand` if you need a completely different palette.

## Configuration

The package reads its config directly from `process.env` on first send —
consumers don't pass it in. Set the env vars below and call methods.

| Env var | Required | Purpose |
|---|---|---|
| `FASTMAIL_API_TOKEN` | no | Fastmail API token with `mail/send` scope. When set, JMAP wins over SMTP. Avoids needing a separate app-specific password the way SMTP would. |
| `SMTP_URL` | no | Nodemailer SMTP URL. Used when `FASTMAIL_API_TOKEN` is unset. Falls through to `LoggingEmailService` (stdout) if also unset. |
| `SMTP_FROM` | no | Default From address. Accepts a bare `local@domain` or a display-name wrapper `"Name" <local@domain>`. When set, overrides whatever `brand.from` the high-level methods produced. |

`LocalEmailService` self-validates at the first method call. Missing /
malformed values throw with a clear list of issues. Processes that don't
actually send email — e.g. an api running with `SCANI_CLOUD_URL` set,
where `EmailFacade` routes everything through the data-provider — never
trip the validation.

## Usage

### Direct (no cloud routing — the data-provider, the worker, anything that
talks to the local transport directly)

```ts
import { LocalEmailService, SCANI_CLOUD_BRAND } from '@scani/email';
import { Container } from 'typedi';

const email = Container.get(LocalEmailService);
await email.sendMagicLink({ to: 'op@example.com', url, brand: SCANI_CLOUD_BRAND });
```

### Via cloud-client facade (the api, the worker — anything that may need to
route through the data-provider)

```ts
import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { Container } from 'typedi';

const email = Container.get(EmailFacade);
await email.sendMagicLink({ to: 'alice@example.com', url });
// When SCANI_CLOUD_URL is set: ships the rendered message to the data-
// provider's email.send tRPC. Otherwise: falls through to LocalEmailService.
```

That's the entire integration: no `configure()` step, no env-shape
declarations in the host app's own zod schema. The host app's only job
is to make sure `FASTMAIL_API_TOKEN` / `SMTP_URL` / `SMTP_FROM` are set
when it actually needs to send (the cloud-routed path doesn't need them
locally).

## Why this package owns its env schema

Two apps used to declare `SMTP_URL` / `SMTP_FROM` / `FASTMAIL_API_TOKEN`
in their own `env.ts`, with matching values in `.env.example`,
`fly.toml`, `docker-compose.yml` — and their boot code each ran an
identical "if env is set, build a transport" block. Three duplications of
the same contract; any drift silently broke one tier. Owning the env
shape inside the package means:

- Apps add nothing to their `env.ts`.
- The contract for "what env vars email needs" lives in one place.
- New transports (SES, Postmark, …) only need a backend-specific README
  note — the env shape is already generic.

## Why cloud routing isn't built into this package

Cloud-routing concerns live in `@scani/cloud-client` (alongside
`StorageFacade`) because they need the typed tRPC client. Email mirrors
storage exactly: the package owns the local impls, `cloud-client` owns
the routing facade. Consumers that want cloud routing inject
`EmailFacade`; consumers that want direct local transport inject
`LocalEmailService`.

## Backends tested

- Fastmail (production — managed deployment via JMAP)
- Mailpit (local dev via docker-compose, `localhost:1026`)
- Stdout logging (zero-config dev fallback for contributors without
  either credential set)
