import { formatDateTime, type RulePreview } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormActions, FormSheet } from '../form/FormSheet';

export function CategoryRulePreviewBody({ preview }: { preview: RulePreview }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <p className="text-body">{preview.accountName}</p>
      <p className="text-label text-muted-foreground">
        {t('v3.categories.rules.counts', {
          changed: preview.changed,
          protected: preview.protected,
          unchanged: preview.unchanged,
        })}
      </p>
      <p className="text-body">{t('v3.categories.rules.reviewedOnly')}</p>
      <ul className="divide-y divide-border">
        {preview.rows.map((row) => (
          <li key={row.transactionId} className="space-y-1 py-3">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 break-words text-body">{row.payee}</span>
              <span className="shrink-0 text-body tabular-nums">
                {row.amount} {row.currency}
              </span>
            </div>
            <p className="text-label text-muted-foreground">{formatDateTime(row.occurredAt)}</p>
            <p className="break-words text-body">
              {row.beforeCategoryLabel ?? t('v3.categories.uncategorized')} →{' '}
              {row.afterCategoryLabel}
            </p>
            <p className="break-words text-label text-muted-foreground">
              {t('v3.categories.rules.match', { key: row.rulePayeeKey })}
              {row.provenanceOnly ? ` · ${t('v3.categories.rules.provenanceOnly')}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
export function CategoryRulePreviewSheet({
  preview,
  pending,
  error,
  needsRefresh,
  onClose,
  onApply,
  onRefresh,
}: {
  preview: RulePreview | null;
  pending: boolean;
  error: string | null;
  needsRefresh: boolean;
  onClose: () => void;
  onApply: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!preview) return;
    setNow(Date.now());
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [preview]);
  const expired = preview !== null && now >= Date.parse(preview.expiresAt);
  return (
    <FormSheet
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t('v3.categories.rules.preview')}
      description={t('v3.categories.rules.previewDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.categories.rules.apply', { count: preview?.changed ?? 0 })}
          pendingLabel={t('v3.categories.rules.applying')}
          onSubmit={onApply}
          onCancel={onClose}
          blockers={
            expired || !preview?.changed || needsRefresh
              ? [
                  expired
                    ? t('v3.categories.rules.expired')
                    : t('v3.categories.rules.refreshNeeded'),
                ]
              : []
          }
          pending={pending}
          error={error}
        />
      }
    >
      {preview && (
        <>
          <CategoryRulePreviewBody preview={preview} />
          <p className="mt-3 text-label text-muted-foreground">
            {t('v3.categories.rules.expires', { time: formatDateTime(preview.expiresAt) })}
          </p>
          {(expired || needsRefresh) && (
            <Button className="mt-3" variant="outline" disabled={pending} onClick={onRefresh}>
              {t('v3.categories.rules.refresh')}
            </Button>
          )}
        </>
      )}
    </FormSheet>
  );
}
