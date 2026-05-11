import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';

// The authed shell wraps every monitored page in `AppShell` (responsive
// sidebar + Sheet drawer + theme toggle + sign-out form). The /auth/*
// routes deliberately sit OUTSIDE this group so unauthenticated visitors
// never see the operator nav. Middleware guarantees we only ever render
// this tree behind a valid passkey session.
export default function AuthedLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
