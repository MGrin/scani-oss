import { Button } from '@scani/ui/ui/button';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Why a row's category was set for the person, and Keep, which makes it theirs
 * (SC-1695). Nothing for a category a person or an import set.
 */
export function AutoCategoryNote({
  setBy,
  payee,
  onKeep,
  pending,
}: {
  setBy: string | null;
  payee: string | null;
  onKeep: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  if (setBy !== 'rule') return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <span className="flex min-w-0 items-center gap-2 text-label text-muted-foreground">
        <Sparkles aria-hidden="true" className="size-4 shrink-0" />
        <span>{t('v3.categories.auto.reasonRule', { payee: payee ?? '' })}</span>
      </span>
      <Button variant="outline" size="sm" onClick={onKeep} disabled={pending}>
        {t('v3.categories.auto.keep')}
      </Button>
    </div>
  );
}
