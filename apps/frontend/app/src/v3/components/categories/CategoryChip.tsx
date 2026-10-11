import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * A category as a row shows it: a colour dot and its name (SC-1652). One a
 * rule or AI set carries a small marker, so a guess never reads as a choice
 * (SC-1695).
 */
export function CategoryChip({
  name,
  color,
  auto = false,
  className,
}: {
  name: string;
  color: string | null;
  auto?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-label',
        className
      )}
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full bg-muted-foreground"
        style={color ? { backgroundColor: color } : undefined}
      />
      <span className="truncate">{name}</span>
      {auto ? (
        <Sparkles
          role="img"
          aria-label={t('v3.categories.auto.marker')}
          className="size-3 shrink-0 text-muted-foreground"
        />
      ) : null}
    </span>
  );
}
