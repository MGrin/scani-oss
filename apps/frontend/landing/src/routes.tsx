import { Outlet, type RouteObject } from 'react-router-dom';
import { Footer } from './components/sections/Footer';
import { TopNav } from './components/sections/TopNav';
import { AlternativesPage } from './pages/AlternativesPage';
import { ComparisonPage } from './pages/ComparisonPage';
import { ContactPage } from './pages/ContactPage';
import { HomePage } from './pages/HomePage';

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <TopNav />
      <Outlet />
      <Footer />
    </div>
  );
}

// Shared route table — `createBrowserRouter` consumes it on the client
// (App.tsx) and `createStaticHandler` consumes it during the build-time
// prerender (entry-server.tsx). Keep it free of browser-only calls so
// both entry points can import it.
export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'contact', element: <ContactPage /> },
      { path: 'alternatives', element: <AlternativesPage /> },
      { path: 'vs/:slug', element: <ComparisonPage /> },
      // Unknown paths fall back to the home page — the `_redirects` SPA
      // rule serves the prerendered index.html, whose canonical points
      // back to `/`, so crawlers de-duplicate cleanly.
      { path: '*', element: <HomePage /> },
    ],
  },
];
