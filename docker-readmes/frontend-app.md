<!-- description: Scani React SPA + nginx. Reverse-proxies /api to the backend. github.com/MGrin/scani-oss -->

# scani/frontend-app

React + Vite SPA served by nginx for **[Scani](https://github.com/MGrin/scani-oss)** —
the self-hostable, open-source portfolio tracker for crypto and traditional
assets.

This is the only Scani container that needs to be reachable from the public
internet. The bundled nginx reverse-proxies `/api` and `/ws` to
[`scani/api`](https://hub.docker.com/r/scani/api) over the compose network, so
the SPA can be deployed against any backend host without rebuilding.

## Tags

- `latest` — head of `main`
- `sha-<short>` — every push to `main`
- `1.2.3` / `1.2` / `1` — semver release tags

The image is built with `VITE_API_URL=/api` baked in — runtime backend
selection happens via nginx config, not via rebuilding the SPA.

## Quick start

Use the reference
[`docker-compose.prod.yml`](https://github.com/MGrin/scani-oss/blob/main/docker-compose.prod.yml)
from the OSS repo:

```bash
git clone https://github.com/MGrin/scani-oss.git
cd scani-oss
cp .env.example .env                              # set BACKEND_URL etc.
docker compose -f docker-compose.prod.yml up -d
```

Put your own TLS-terminating reverse proxy (Caddy, Cloudflare Tunnel, an
ingress, …) in front of this container.

## Required environment variables

| Variable | Purpose |
|---|---|
| `BACKEND_URL` | Where nginx proxies `/api` and `/ws` — typically `http://api:3001` inside the compose network |
| `FRONTEND_URL` | Public origin the browser hits; powers CORS + cookies |

Full annotated list: [`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example).

## Source

Full source, architecture, and contribution guidelines:
**https://github.com/MGrin/scani-oss**

MIT licensed.
