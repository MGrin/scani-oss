import { useTranslation } from 'react-i18next';

/**
 * Said before a key is pasted, for a provider with no read-only key (SC-1729:
 * bunq's keys "grant broad permissions"). Scani's own code only reads; the key
 * it is handed can do more, and the reader should know that first.
 */
export function KeyCanMoveMoneyNote({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <p className="rounded-md border border-border-strong bg-surface-hover p-3 text-caption">
      {t('v3.capture.integration.keyCanMoveMoney', { name })}
    </p>
  );
}
