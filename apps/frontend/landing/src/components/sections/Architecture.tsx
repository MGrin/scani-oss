import { Activity, Layers, Repeat, Sigma } from 'lucide-react';

interface Pillar {
  Icon: typeof Layers;
  title: string;
  body: string;
}

const PILLARS: ReadonlyArray<Pillar> = [
  {
    Icon: Layers,
    title: 'One codebase, three deployments',
    body: 'The same backend, worker, and data plane boot identically on your laptop, your VPS, or our managed cloud — same binary, same behavior.',
  },
  {
    Icon: Sigma,
    title: 'Money is hard; we know',
    body: 'Floats round. Currencies drift. Stale prices lie. Scani stores every amount in arbitrary-precision decimal end-to-end and reconciles balances against historical prices, so a portfolio total never lies because of a binary representation.',
  },
  {
    Icon: Repeat,
    title: 'Distributed job processing',
    body: 'Pricing, balance syncs, payouts, transfer linking — every long-running task runs on a durable queue that survives restarts, retries on transient failure, and back-pressures gracefully under load.',
  },
  {
    Icon: Activity,
    title: 'Live by default',
    body: 'Balances and prices update as soon as upstream changes; the dashboard reflects them within seconds. No polling buttons, no "last refreshed 4 minutes ago" stamps.',
  },
];

export function Architecture() {
  return (
    <section className="border-b border-border/60 bg-background py-12 sm:py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              The architecture
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Built like infrastructure, not a product demo.
            </h2>
            <p className="mt-4 text-muted-foreground">
              One codebase, packaged three ways.{' '}
              <strong className="text-foreground">No service-fragmentation tax</strong> — a fix
              shipped to a self-hosted instance is the same fix running on our managed cloud,
              because they're the same binary.
            </p>
            <ul className="mt-8 grid gap-5 sm:grid-cols-2">
              {PILLARS.map(({ Icon, title, body }) => (
                <li key={title} className="flex gap-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                  <div>
                    <div className="text-sm font-medium">{title}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Three-layer architectural diagram: external assets feed
           * into the Scani core, which deploys to either your infra
           * or our managed cloud. Deliberately avoids naming specific
           * tooling so the diagram doesn't rot when implementation
           * details change underneath. */}
          <div className="relative rounded-xl border border-border bg-card p-6">
            <svg
              viewBox="0 0 420 360"
              className="h-auto w-full text-foreground"
              role="img"
              aria-label="Layered architecture: your assets flow into Scani core, which deploys to either self-host or our managed cloud."
            >
              <defs>
                <pattern id="arch-dots" width="8" height="8" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" fill="currentColor" opacity="0.12" />
                </pattern>
                <marker
                  id="arch-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity="0.55" />
                </marker>
              </defs>
              <rect width="420" height="360" fill="url(#arch-dots)" />

              {/* Row 1 — your assets feed in */}
              <rect
                x="30"
                y="20"
                width="360"
                height="64"
                rx="10"
                fill="currentColor"
                fillOpacity="0.04"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <text
                x="210"
                y="44"
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="currentColor"
              >
                Your assets
              </text>
              <text
                x="210"
                y="62"
                textAnchor="middle"
                fontSize="10"
                fill="currentColor"
                opacity="0.6"
              >
                banks · brokerages · exchanges · chains
              </text>
              <text
                x="210"
                y="76"
                textAnchor="middle"
                fontSize="9"
                fill="currentColor"
                opacity="0.45"
              >
                read-only, your credentials
              </text>

              <line
                x1="210"
                y1="84"
                x2="210"
                y2="124"
                stroke="currentColor"
                strokeWidth="1.4"
                opacity="0.55"
                markerEnd="url(#arch-arrow)"
                strokeDasharray="3 3"
              />

              {/* Row 2 — Scani core, "the constant" */}
              <rect
                x="30"
                y="130"
                width="360"
                height="100"
                rx="10"
                fill="currentColor"
                fillOpacity="0.09"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <text
                x="210"
                y="155"
                textAnchor="middle"
                fontSize="12"
                fontWeight="700"
                fill="currentColor"
              >
                Scani core
              </text>
              <text
                x="210"
                y="170"
                textAnchor="middle"
                fontSize="9"
                fill="currentColor"
                opacity="0.55"
              >
                the constant — same code on every deployment
              </text>

              {[
                { x: 50, label: 'API', w: 60 },
                { x: 125, label: 'Async queue', w: 85 },
                { x: 225, label: 'Workers', w: 70 },
                { x: 310, label: 'Durable store', w: 80 },
              ].map((p) => (
                <g key={p.label}>
                  <rect
                    x={p.x}
                    y="186"
                    width={p.w}
                    height="28"
                    rx="14"
                    fill="currentColor"
                    fillOpacity="0.06"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                  <text
                    x={p.x + p.w / 2}
                    y="204"
                    textAnchor="middle"
                    fontSize="10"
                    fontWeight="500"
                    fill="currentColor"
                  >
                    {p.label}
                  </text>
                </g>
              ))}

              <line
                x1="115"
                y1="230"
                x2="115"
                y2="270"
                stroke="currentColor"
                strokeWidth="1.4"
                opacity="0.55"
                markerEnd="url(#arch-arrow)"
                strokeDasharray="3 3"
              />
              <line
                x1="305"
                y1="230"
                x2="305"
                y2="270"
                stroke="currentColor"
                strokeWidth="1.4"
                opacity="0.55"
                markerEnd="url(#arch-arrow)"
                strokeDasharray="3 3"
              />

              {/* Row 3 — two deployment shapes */}
              <rect
                x="30"
                y="276"
                width="170"
                height="64"
                rx="10"
                fill="currentColor"
                fillOpacity="0.04"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <text
                x="115"
                y="300"
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="currentColor"
              >
                Self-host
              </text>
              <text
                x="115"
                y="318"
                textAnchor="middle"
                fontSize="9"
                fill="currentColor"
                opacity="0.55"
              >
                on your infrastructure
              </text>

              <rect
                x="220"
                y="276"
                width="170"
                height="64"
                rx="10"
                fill="currentColor"
                fillOpacity="0.04"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <text
                x="305"
                y="300"
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="currentColor"
              >
                Managed cloud
              </text>
              <text
                x="305"
                y="318"
                textAnchor="middle"
                fontSize="9"
                fill="currentColor"
                opacity="0.55"
              >
                on ours, audited &amp; compliant
              </text>
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}
