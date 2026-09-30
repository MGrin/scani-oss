import { Block } from '@scani/ui/v3/components/Block';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A card that says something about the screen rather than being part of it:
 * an icon, then caption lines, then an optional action. The review queues'
 * summaries and the capture screens' AI notice each drew their own, and no two
 * matched — a warning card, a plain card with a larger lead sentence, and a
 * bordered box with body text and an underlined link (SC-1433).
 */
export function Callout({
  icon: Icon,
  children,
  action,
  role,
}: {
  icon: LucideIcon;
  children: ReactNode;
  action?: ReactNode;
  role?: 'status';
}) {
  return (
    <Block className="flex gap-3 p-4">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-col items-start gap-1 text-caption" role={role}>
        {children}
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </Block>
  );
}
