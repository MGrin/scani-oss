import { useEffect } from 'react';
import { Architecture } from './components/sections/Architecture';
import { BetaPromise } from './components/sections/BetaPromise';
import { Contact } from './components/sections/Contact';
import { FAQ } from './components/sections/FAQ';
import { Footer } from './components/sections/Footer';
import { Hero } from './components/sections/Hero';
import { OSSContributors } from './components/sections/OSSContributors';
import { Problem } from './components/sections/Problem';
import { ProductShowcase } from './components/sections/ProductShowcase';
import { Tiers } from './components/sections/Tiers';
import { TopNav } from './components/sections/TopNav';
import { useSystemPreferences } from './hooks/useSystemPreferences';

function HomePage() {
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

function ContactPage() {
  // The index.html title is tuned for the home page; swap it while the
  // contact route is mounted and restore it on unmount so a client-side
  // return to `/` doesn't keep the contact title.
  useEffect(() => {
    const previous = document.title;
    document.title = 'Contact Scani — talk to the team';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <main>
      <Contact />
    </main>
  );
}

export function App() {
  const { theme } = useSystemPreferences();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
    root.dataset.theme = theme;
  }, [theme]);

  // Minimal path routing — the marketing site has exactly two pages and
  // navigation is plain `<a href>` (full reload), so a router dependency
  // would be overkill. The `_redirects` SPA fallback ensures a deep link
  // to /contact serves index.html.
  const path = typeof window !== 'undefined' ? window.location.pathname.replace(/\/+$/, '') : '';
  const isContact = path === '/contact';

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <TopNav />
      {isContact ? <ContactPage /> : <HomePage />}
      <Footer />
    </div>
  );
}
