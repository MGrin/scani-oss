import type { Comparison } from '../../data/comparisons';

export function ComparisonTable({ comparison }: { comparison: Comparison }) {
  return (
    <section className="border-b border-border/60 bg-background py-12 sm:py-20">
      <div className="mx-auto max-w-3xl px-6">
        <h2 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          Scani vs {comparison.competitor}, feature by feature
        </h2>
        <div className="mt-8 overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-card text-left">
                <th className="px-4 py-3 font-medium">Feature</th>
                <th className="px-4 py-3 font-medium">Scani</th>
                <th className="px-4 py-3 font-medium">{comparison.competitor}</th>
              </tr>
            </thead>
            <tbody>
              {comparison.featureRows.map((row) => (
                <tr key={row.feature} className="border-b border-border/60 last:border-b-0">
                  <th scope="row" className="px-4 py-3 text-left align-top font-medium">
                    {row.feature}
                  </th>
                  <td className="px-4 py-3 align-top text-muted-foreground">{row.scani}</td>
                  <td className="px-4 py-3 align-top text-muted-foreground">{row.competitor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{comparison.verdict}</p>
      </div>
    </section>
  );
}
