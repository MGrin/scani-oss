import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeBridge } from '@/components/ThemeBridge';
import './globals.css';

export const metadata: Metadata = {
  title: 'Scani Admin',
  description: 'Infrastructure & usage overview',
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
      </body>
    </html>
  );
}
