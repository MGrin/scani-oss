import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

interface QA {
  q: string;
  a: string;
}

const QAS: ReadonlyArray<QA> = [
  {
    q: 'When does billing actually start?',
    a: "No date locked in yet — we wire it on once the cloud-management plane has been running steadily for a while and we're confident the metering numbers are right. The waitlist + the beta-preview promise exist precisely so you don't need to track that timeline.",
  },
  {
    q: 'What counts as a "significant" OSS contribution?',
    a: "We'll publish concrete heuristics with the license, but the working definition is: a merged PR that fixes a real bug, ships a new integration provider, or meaningfully improves an existing one. Single-line typo fixes are appreciated but don't qualify.",
  },
  {
    q: 'Can I self-host today?',
    a: 'Yes — the Docker stack boots with `docker compose --profile full up -d --build`. Your data stays on your machine. The OSS license is still being prepared, so the code is source-available now and properly licensed soon.',
  },
  {
    q: 'Where is my data hosted on the managed tier?',
    a: 'Postgres on Neon (eu-central / us-east), Redis on Upstash, object storage on Cloudflare R2, compute on Fly.io. Everything is provisioned in Terraform under `infra/terraform/` so you can audit the topology without our help.',
  },
  {
    q: 'Is the API the same code as the dashboard uses?',
    a: 'Yes. The data-provider service that powers app.scani.xyz is the same one customers hit at api.cloud.scani.xyz — we eat our own dog food. The OpenAPI spec at /docs is generated from the live router.',
  },
  {
    q: 'Why three tiers? Why not just SaaS?',
    a: 'Different users have different trust models. Self-hosters want their data on their box. Builders want a managed API surface but their own infra. End-users want zero ops. Same code, three deployment shapes — pick the one that matches.',
  },
];

function FaqItem({ qa, isOpen, onToggle }: { qa: QA; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-6 py-5 text-left"
      >
        <span className="text-sm font-medium">{qa.q}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>
      {isOpen && (
        <div className="pb-5 pr-10 text-sm leading-relaxed text-muted-foreground">{qa.a}</div>
      )}
    </div>
  );
}

export function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  return (
    <section className="border-b border-border/60 bg-background py-20 sm:py-28">
      <div className="mx-auto max-w-3xl px-6">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">FAQ</p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Things people ask first.
          </h2>
        </div>
        <div className="mt-12 rounded-xl border border-border bg-card px-6">
          {QAS.map((qa, i) => (
            <FaqItem
              key={qa.q}
              qa={qa}
              isOpen={openIdx === i}
              onToggle={() => setOpenIdx(openIdx === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
