import { useEffect } from 'react';
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
import { useSystemPreferences } from './hooks/useSystemPreferences';

export function App() {
  const { theme } = useSystemPreferences();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
    root.dataset.theme = theme;
  }, [theme]);

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
