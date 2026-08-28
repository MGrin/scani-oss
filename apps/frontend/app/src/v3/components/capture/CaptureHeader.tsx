import { cn } from '@scani/ui/lib/cn';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { Button } from '@scani/ui/ui/button';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { V3_BASE } from '../../lib/ui-version';

/**
 * The top of a capture form — the way out, what this screen takes, and one line
 * on what happens to it.
 *
 * The back link is a real destination rather than `history.back()`: these
 * screens are reached from a sheet that has already closed, and from a
 * notification, and from a bookmark, so "back" is not a thing the page knows.
 */
export function CaptureHeader({
  title,
  description,
  backTo = V3_BASE,
  backLabel = 'Home',
}: {
  title: string;
  description: ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Button variant="ghost" asChild className="-ms-2 self-start">
        <Link to={backTo}>
          <ArrowLeft className={cn(MIRROR_IN_RTL, 'me-1 size-4')} aria-hidden="true" />
          {backLabel}
        </Link>
      </Button>
      <h1 className="text-title">{title}</h1>
      <p className="text-body text-muted-foreground">{description}</p>
    </div>
  );
}
