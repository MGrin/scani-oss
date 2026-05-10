import { Architecture } from './components/sections/Architecture';
import { BetaPromise } from './components/sections/BetaPromise';
import { FAQ } from './components/sections/FAQ';
import { Footer } from './components/sections/Footer';
import { Hero } from './components/sections/Hero';
import { OSSContributors } from './components/sections/OSSContributors';
import { Problem } from './components/sections/Problem';
import { ProductShowcase } from './components/sections/ProductShowcase';
import { Tiers } from './components/sections/Tiers';
import { TopNav } from './components/sections/TopNav';

export function App() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <TopNav />
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
      <Footer />
    </div>
  );
}
