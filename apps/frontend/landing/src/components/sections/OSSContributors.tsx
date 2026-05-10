import { Bug, Github, GitPullRequest, Plug } from 'lucide-react';

const REWARD_TYPES = [
  {
    Icon: Bug,
    title: 'Bug fixes that hold up in prod',
    body: 'Real-world repros, regression tests, no smell.',
  },
  {
    Icon: Plug,
    title: 'New integrations',
    body: 'A new bank / broker / exchange / chain wired into the provider registry.',
  },
  {
    Icon: GitPullRequest,
    title: 'Integration improvements',
    body: 'Better reliability, more coverage, or fewer rate-limit incidents on an existing provider.',
  },
];

export function OSSContributors() {
  return (
    <section className="border-b border-border/60 bg-background py-20 sm:py-28">
      <div className="mx-auto max-w-4xl px-6">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            For contributors
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Land a real PR. Get the paid tiers, free, forever.
          </h2>
          <p className="mt-4 text-balance text-muted-foreground">
            We'll be opening the source under a permissive license shortly. Anyone whose merged
            contribution shows up in the kinds of work below gets a free-forever license to every
            paid tier — no deprecation, no clawback.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {REWARD_TYPES.map(({ Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-border bg-card p-5">
              <Icon className="h-5 w-5 text-foreground" />
              <h3 className="mt-3 text-sm font-medium">{title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-xl border border-dashed border-border bg-card/50 p-5 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Honest disclaimer:</strong> the OSS license isn't
            merged yet. The code is public and readable today, but we'll ship a proper license +
            CONTRIBUTING guide before we accept external PRs. Star the repo to know when that lands
            — the offer applies to every significant contribution from that point onward.
          </p>
        </div>

        <div className="mt-8 flex justify-center">
          <a
            href="https://github.com/MGrin/scani"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-11 items-center gap-2 rounded-md border border-border bg-card px-5 text-sm font-medium transition-colors hover:bg-accent"
          >
            <Github className="h-4 w-4" />
            Browse the source on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
