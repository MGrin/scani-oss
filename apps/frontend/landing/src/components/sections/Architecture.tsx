import { Database, GitBranch, Globe, Server } from 'lucide-react';

interface Pillar {
  Icon: typeof Server;
  title: string;
  body: string;
}

const PILLARS: ReadonlyArray<Pillar> = [
  {
    Icon: GitBranch,
    title: 'One codebase, three deployments',
    body: 'A backend, a worker, and a data-provider — packaged as Docker images that boot identically on a laptop, your VPS, or our Fly cluster.',
  },
  {
    Icon: Database,
    title: 'Drizzle + Postgres',
    body: 'Type-safe schema in code, real migrations on disk. Decimal.js for money so floats never round your balance.',
  },
  {
    Icon: Server,
    title: 'BullMQ on Redis',
    body: 'Pricing, balance syncs, payouts, transfer linking — every long-running job lives in queues that survive restarts.',
  },
  {
    Icon: Globe,
    title: 'tRPC end-to-end',
    body: 'API + worker + frontends share types. Add a field to the schema, every caller sees it at compile time.',
  },
];

export function Architecture() {
  return (
    <section className="border-b border-border/60 bg-background py-20 sm:py-28">
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
              Bun, tRPC, Drizzle, BullMQ, Postgres, Redis. Strictly typed end-to-end. No
              service-fragmentation tax — the same code runs every tier, so an upstream fix in
              self-host lands in managed SaaS automatically.
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

          {/* Inline SVG diagram — three deployment shapes feeding the
           * shared core. Renders in light + dark theme via currentColor. */}
          <div className="relative rounded-xl border border-border bg-card p-6">
            <svg
              viewBox="0 0 420 320"
              className="h-auto w-full text-foreground"
              role="img"
              aria-label="Three deployment shapes: self-host, cloud API, managed SaaS — sharing the same Scani core."
            >
              <defs>
                <pattern id="dots" width="8" height="8" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" fill="currentColor" opacity="0.15" />
                </pattern>
              </defs>
              <rect width="420" height="320" fill="url(#dots)" />

              {/* Core */}
              <rect
                x="155"
                y="135"
                width="110"
                height="50"
                rx="8"
                fill="currentColor"
                fillOpacity="0.08"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <text
                x="210"
                y="158"
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="currentColor"
              >
                @scani/* core
              </text>
              <text
                x="210"
                y="172"
                textAnchor="middle"
                fontSize="9"
                fill="currentColor"
                opacity="0.6"
              >
                api · worker · data-provider
              </text>

              {/* Three deployment shapes */}
              {[
                { x: 30, y: 55, label: 'Self-host', sub: 'Docker on your box' },
                { x: 165, y: 35, label: 'Cloud API', sub: 'api.cloud.scani.xyz' },
                { x: 300, y: 55, label: 'Managed SaaS', sub: 'app.scani.xyz' },
              ].map((node) => (
                <g key={node.label}>
                  <rect
                    x={node.x}
                    y={node.y}
                    width="90"
                    height="46"
                    rx="6"
                    fill="currentColor"
                    fillOpacity="0.04"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <text
                    x={node.x + 45}
                    y={node.y + 21}
                    textAnchor="middle"
                    fontSize="11"
                    fontWeight="500"
                    fill="currentColor"
                  >
                    {node.label}
                  </text>
                  <text
                    x={node.x + 45}
                    y={node.y + 35}
                    textAnchor="middle"
                    fontSize="9"
                    fill="currentColor"
                    opacity="0.55"
                  >
                    {node.sub}
                  </text>
                </g>
              ))}

              {/* Connectors */}
              <g stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.5">
                <line x1="75" y1="101" x2="170" y2="135" />
                <line x1="210" y1="81" x2="210" y2="135" />
                <line x1="345" y1="101" x2="250" y2="135" />
              </g>

              {/* Bottom: shared infra */}
              <g>
                {[
                  { x: 50, label: 'Postgres' },
                  { x: 145, label: 'Redis' },
                  { x: 240, label: 'R2 / S3' },
                  { x: 330, label: 'Providers' },
                ].map((n) => (
                  <g key={n.label}>
                    <rect
                      x={n.x}
                      y="240"
                      width="65"
                      height="36"
                      rx="6"
                      fill="currentColor"
                      fillOpacity="0.04"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <text
                      x={n.x + 32.5}
                      y="262"
                      textAnchor="middle"
                      fontSize="10"
                      fill="currentColor"
                      opacity="0.75"
                    >
                      {n.label}
                    </text>
                  </g>
                ))}
              </g>
              <g stroke="currentColor" strokeWidth="1" opacity="0.35">
                <line x1="180" y1="185" x2="82" y2="240" />
                <line x1="200" y1="185" x2="177" y2="240" />
                <line x1="220" y1="185" x2="272" y2="240" />
                <line x1="240" y1="185" x2="362" y2="240" />
              </g>
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}
