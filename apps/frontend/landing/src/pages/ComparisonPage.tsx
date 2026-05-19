import { useParams } from 'react-router-dom';
import { BetaPromise } from '../components/sections/BetaPromise';
import { ComparisonHero } from '../components/sections/ComparisonHero';
import { ComparisonTable } from '../components/sections/ComparisonTable';
import { getComparison } from '../data/comparisons';

export function ComparisonPage() {
  const { slug } = useParams();
  const comparison = getComparison(slug);

  if (!comparison) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-32 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Comparison not found</h1>
        <p className="mt-4 text-muted-foreground">
          We don't have that comparison yet — but there are plenty more.
        </p>
        <a
          href="/alternatives"
          className="mt-8 inline-flex h-11 items-center justify-center rounded-md bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          See all comparisons
        </a>
      </main>
    );
  }

  return (
    <main>
      <ComparisonHero comparison={comparison} />
      <ComparisonTable comparison={comparison} />
      <BetaPromise />
    </main>
  );
}
