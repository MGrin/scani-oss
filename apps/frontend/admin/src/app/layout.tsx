import { UpdateBanner } from '@scani/ui/components/UpdateBanner';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import { ThemeBridge } from '@/components/ThemeBridge';
import './globals.css';

export const metadata: Metadata = {
  title: 'Scani Admin',
  description: 'Infrastructure & usage overview',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Admin',
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { url: '/icons/icon-180x180.png', sizes: '180x180', type: 'image/png' },
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: '#1a1f2e',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// SSR default is dark; the client-side ThemeProvider re-reads the
// 'scani-admin-theme' localStorage entry post-hydration and switches if
// the operator picked light. We can't ship an inline no-FOUC script
// because admin's CSP is `script-src 'self'` (no nonce / unsafe-inline);
// the brief dark-flash on light-theme is acceptable for a dashboard.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning>
      <body className="bg-background text-foreground">
        <ThemeBridge>
          <div className="min-h-screen">{children}</div>
        </ThemeBridge>
        <UpdateBanner />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
