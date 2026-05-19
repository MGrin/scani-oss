import { Architecture } from '../components/sections/Architecture';
import { BetaPromise } from '../components/sections/BetaPromise';
import { FAQ } from '../components/sections/FAQ';
import { Hero } from '../components/sections/Hero';
import { OSSContributors } from '../components/sections/OSSContributors';
import { Problem } from '../components/sections/Problem';
import { ProductShowcase } from '../components/sections/ProductShowcase';
import { Tiers } from '../components/sections/Tiers';

export function HomePage() {
  return (
    <main>
      <Hero />
      <Problem />
      <ProductShowcase />
      <Tiers />
      <Architecture />
      <BetaPromise />
      <OSSContributors />
      <FAQ />
    </main>
  );
}
