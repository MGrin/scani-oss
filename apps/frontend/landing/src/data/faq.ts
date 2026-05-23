export interface QA {
  q: string;
  a: string;
}

export const QAS: ReadonlyArray<QA> = [
  {
    q: 'When does billing actually start?',
    a: "No date locked in yet — we wire it on once the cloud-management plane has been running steadily for a while and we're confident the metering numbers are right. The waitlist + the beta-preview promise exist precisely so you don't need to track that timeline.",
  },
  {
    q: 'What counts as a "significant" OSS contribution?',
    a: "The working definition is: a merged PR on github.com/MGrin/scani-oss that fixes a real bug, ships a new integration provider, or meaningfully improves an existing one. Single-line typo fixes are appreciated but don't qualify. Once your PR is merged, reply to your account-creation email with the PR link and we flag your account as a contributor.",
  },
  {
    q: 'Can I self-host today?',
    a: 'Yes — the source is open at github.com/MGrin/scani-oss under MIT. Pre-built multi-arch Docker images publish on every push to main (`scani/api`, `scani/worker`, `scani/data-provider`, `scani/frontend-app`); `docker compose -f docker-compose.prod.yml up -d` brings up the whole stack. You bring your own Postgres, Redis, and S3-compatible storage, or let the bundled containers handle them. Your data never leaves your machine.',
  },
  {
    q: 'Where is my data hosted on the managed tier?',
    a: "On top-tier managed-infrastructure providers — database, cache, object storage, and compute — all of them SOC 2 / ISO 27001 audited and GDPR-compliant. We're working through our own SOC 2 audit and will publish the report once it's signed off. EU customers' data lives in EU regions, US customers' in US regions, and you choose at signup.",
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
