import { cn } from '@scani/ui/lib/cn';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { Button } from '@scani/ui/ui/button';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

/** "Back to …" above a detail page's title (UI standard rule 7). */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Button variant="ghost" size="sm" asChild className="-ms-2 self-start">
      <Link to={to}>
        <ArrowLeft className={cn(MIRROR_IN_RTL, 'me-2 size-4')} aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}
