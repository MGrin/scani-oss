import { InstallPromptBanner } from '@scani/ui';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';

// The authed shell wraps every monitored page in `AppShell` (responsive
// sidebar + Sheet drawer + theme toggle + sign-out form). The /auth/*
// routes deliberately sit OUTSIDE this group so unauthenticated visitors
// never see the operator nav. Middleware guarantees we only ever render
// this tree behind a valid passkey session — so the install banner can
// hardcode isLoggedIn={true}.
export default function AuthedLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <InstallPromptBanner isLoggedIn appName="Scani Admin" />
      <AppShell>{children}</AppShell>
    </>
  );
}
