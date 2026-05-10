import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Scani Admin',
  description: 'Infrastructure & usage overview',
};

// Admin locks itself to the dark theme via the className + data-theme
// attribute on <html>. The @scani/ui design-system tokens (loaded in
// globals.css) emit dark-variant values under both signals, so every
// `bg-background` / `text-foreground` / `border-border` resolves to the
// dark scale without ad-hoc inline overrides.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" data-theme="dark">
      <body className="bg-background text-foreground">
        <div className="min-h-screen">{children}</div>
      </body>
    </html>
  );
}
