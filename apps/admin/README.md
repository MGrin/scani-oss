# scani admin

Internal infrastructure dashboard. Deployed to Cloudflare Pages at
`admin.scani.xyz`, gated by a single passkey stored in 1Password.

## Local dev

```bash
cd apps/admin
./scripts/sync-env.sh       # writes .env.local from ~/.secrets
bun dev                     # http://127.0.0.1:5175
```

`sync-env.sh` sets `ADMIN_DEV_BYPASS=1` so the passkey check is skipped
locally. The dev server binds to `127.0.0.1` only.

## Production rollout

Everything Terraform can own is already automated by the `terraform.yaml`
workflow (DNS + `cloudflare_pages_domain`). Everything `wrangler` can own
is automated by the `deploy-admin` job (Pages project creation + secret
upserts from GitHub secrets).

The **only** things that cannot be automated — because WebAuthn needs a
real browser with an authenticator — happen through the in-app bootstrap
page.

### First-time steps (do once, before merging the PR)

```bash
# 1. Pick a one-time bootstrap token (any ≥16-char string).
gh secret set ADMIN_BOOTSTRAP_TOKEN --body "$(openssl rand -hex 32)"

# 2. Add the Fastmail token (only one not already in GH secrets; optional).
gh secret set FASTMAIL_API_TOKEN --body "<paste from ~/.secrets>"
```

That's it — merge the PR.

### What happens on merge

1. `terraform.yaml` applies → `admin.scani.xyz` CNAME + Pages domain binding.
2. `deploy-admin` job:
   - Creates `scani-admin` Pages project if missing.
   - Upserts every available GH secret (provider tokens + `ADMIN_BOOTSTRAP_TOKEN`) into Pages secrets.
   - Publishes the built app.
3. You visit `https://admin.scani.xyz/` → redirected to `/auth/bootstrap`.

### One-shot passkey registration

```
1. Open https://admin.scani.xyz/auth/bootstrap
2. Paste the bootstrap token → click "Create passkey"
3. 1Password prompts — save the passkey to your vault
4. The page displays the 3 secrets exactly once. Run the printed
   `gh secret set ... / gh secret delete / gh workflow run` block.
5. Next deploy completes (~1 min). /auth/bootstrap now 404s, /auth/login
   accepts your passkey.
```

### Locked-down state

- `ADMIN_PASSKEY_CREDENTIAL_ID` present in secrets  
- `ADMIN_BOOTSTRAP_TOKEN` absent (the CI job auto-deletes it on next deploy if the passkey is set)
- `/auth/bootstrap` returns 403 even if someone guesses a token

### Rotating the passkey

Lost the passkey / rotating:

```bash
gh secret delete ADMIN_PASSKEY_CREDENTIAL_ID
gh secret delete ADMIN_PASSKEY_PUBLIC_KEY
gh secret delete ADMIN_SESSION_SECRET
gh secret set ADMIN_BOOTSTRAP_TOKEN --body "$(openssl rand -hex 32)"
gh workflow run deploy-fly.yaml -f services=admin
```

Then repeat the one-shot registration flow.

## Architecture notes

- **Edge runtime**: every page/route declares `export const runtime = 'edge'`. `@cloudflare/next-on-pages` compiles to a Pages Function bundle.
- **Auth**: WebAuthn (`@simplewebauthn/server`). Session cookie is HMAC-signed (`ADMIN_SESSION_SECRET`), sliding 7-day TTL, refreshed on each authenticated request by `middleware.ts`. No user table — a single credential ID + public key in env vars is the entire auth surface.
- **Bootstrap**: `/auth/bootstrap` is live only when `ADMIN_BOOTSTRAP_TOKEN` is set AND `ADMIN_PASSKEY_CREDENTIAL_ID` is unset. CI wipes the bootstrap token on the deploy after registration.
- **DB**: `@neondatabase/serverless` (HTTP-over-Postgres). Connection URL derived at runtime from the Neon API — zero hardcoded DB URLs.
- **Local bypass**: `ADMIN_DEV_BYPASS=1` in `.env.local` short-circuits middleware. Never set it in Cloudflare.
