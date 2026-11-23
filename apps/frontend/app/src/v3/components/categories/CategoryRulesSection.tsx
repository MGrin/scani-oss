import {
  type CategoryRuleSave,
  formatDateTime,
  type RulePreview,
  type RuleScope,
  type SavedCategoryRule,
} from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { trpc } from '@/lib/trpc';
import { FormActions, FormSheet } from '../form/FormSheet';
import { type CategoryNodeView, formatCategoryPath } from './CategoryPicker';
import { CategoryRuleFormSheet } from './CategoryRuleFormSheet';
import { CategoryRulePreviewSheet } from './CategoryRulePreviewSheet';

export function CategoryRulesSection({
  nodes,
  draft,
  onDraft,
}: {
  nodes: readonly CategoryNodeView[];
  draft: CategoryRuleSave | null;
  onDraft: (draft: CategoryRuleSave | null) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const rules = trpc.categories.rules.list.useQuery();
  const recent = trpc.categories.rules.recent.useQuery();
  const accountQuery = trpc.accounts.getAll.useQuery();
  const accounts = (accountQuery.data ?? []).filter((a) => a.userId === user?.id);
  const [accountId, setAccountId] = useState('');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [deleting, setDeleting] = useState<SavedCategoryRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const failure = (message: string) =>
    t(
      [
        'NOT_FOUND',
        'INVALID_RULE',
        'DUPLICATE_RULE',
        'RULE_LIMIT',
        'REVISION_CONFLICT',
        'TOO_MANY_ROWS',
        'PREVIEW_LIMIT',
        'STALE_PREVIEW',
        'PREVIEW_EXPIRED',
        'UNDO_CONFLICT',
        'ALREADY_UNDONE',
        'BUSY',
        'NO_CHANGES',
      ].includes(message)
        ? `v3.categories.rules.errors.${message}`
        : 'v3.categories.rules.error'
    );
  const refresh = () =>
    Promise.all([utils.categories.invalidate(), utils.transactions.invalidate()]);
  const save = trpc.categories.rules.save.useMutation({
    onSuccess: async () => {
      await refresh();
      onDraft(null);
      setError(null);
    },
    onError: (e) => setError(failure(e.message)),
    retry: false,
  });
  const remove = trpc.categories.rules.remove.useMutation({
    onSuccess: async () => {
      await refresh();
      setDeleting(null);
      setError(null);
    },
    onError: (e) => setError(failure(e.message)),
    retry: false,
  });
  const makePreview = trpc.categories.rules.preview.useMutation({
    onSuccess: (value) => {
      setPreview(value);
      setApplyError(null);
      setNeedsRefresh(false);
    },
    onError: (e) => setError(failure(e.message)),
    retry: false,
  });
  const apply = trpc.categories.rules.apply.useMutation({
    onSuccess: async () => {
      setPreview(null);
      setApplyError(null);
      await refresh();
    },
    onError: (e) => {
      setApplyError(failure(e.message));
      setNeedsRefresh(
        ['STALE_PREVIEW', 'PREVIEW_EXPIRED', 'NOT_FOUND', 'ALREADY_UNDONE'].includes(e.message)
      );
    },
    retry: false,
  });
  const undo = trpc.categories.rules.undo.useMutation({
    onSuccess: async () => {
      await refresh();
      setError(null);
    },
    onError: (e) => setError(failure(e.message)),
    retry: false,
  });
  const previewScope = (scope?: RuleScope) => {
    setError(null);
    if (scope) return makePreview.mutate(scope);
    if (!accountId || !/^\d{4}-\d{2}$/.test(month)) return;
    const start = new Date(`${month}-01T00:00:00Z`);
    if (!Number.isFinite(start.getTime())) return;
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    makePreview.mutate({ accountId, from: start.toISOString(), to: end.toISOString() });
  };
  const pending = save.isPending || remove.isPending;
  return (
    <section
      id="saved-rules"
      aria-labelledby="saved-rules-heading"
      className="mt-8 space-y-5 border-t border-border pt-6"
    >
      <h2 id="saved-rules-heading" className="text-title">
        {t('v3.categories.rules.title')}
      </h2>
      <p className="text-body text-muted-foreground">{t('v3.categories.rules.definition')}</p>
      {error && (
        <p role="alert" className="text-body text-destructive">
          {error}
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              void refresh();
            }}
          >
            {t('v3.categories.rules.reload')}
          </Button>
        </p>
      )}
      {rules.isLoading || accountQuery.isLoading ? (
        <p role="status">{t('v3.categories.rules.loading')}</p>
      ) : rules.isError || accountQuery.isError ? (
        <Button
          variant="outline"
          onClick={() => {
            void rules.refetch();
            void accountQuery.refetch();
          }}
        >
          {t('v3.categories.rules.reload')}
        </Button>
      ) : (
        <ul className="divide-y divide-border">
          {(rules.data ?? []).map((rule) => (
            <li key={rule.id} className="space-y-2 py-3">
              <p className="break-words text-body">{rule.payeeKey}</p>
              <p className="break-words text-label text-muted-foreground">
                {accounts.find((a) => a.id === rule.accountId)?.name} →{' '}
                {formatCategoryPath(nodes, rule.categoryId)}
                {!rule.enabled ? ` · ${t('v3.categories.rules.disabled')}` : ''}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    onDraft({
                      id: rule.id,
                      expectedRevision: rule.revision,
                      payeeText: rule.payeeKey,
                      accountId: rule.accountId,
                      categoryId: rule.categoryId,
                      enabled: rule.enabled,
                    });
                  }}
                >
                  {t('v3.categories.rules.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    save.mutate({
                      id: rule.id,
                      expectedRevision: rule.revision,
                      payeeText: rule.payeeKey,
                      accountId: rule.accountId,
                      categoryId: rule.categoryId,
                      enabled: !rule.enabled,
                    })
                  }
                >
                  {t(rule.enabled ? 'v3.categories.rules.disable' : 'v3.categories.rules.enable')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    setDeleting(rule);
                  }}
                >
                  {t('v3.categories.page.deleteAction')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-3">
        <h3 className="text-body font-medium">{t('v3.categories.rules.applyTitle')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="preview-account">{t('v3.categories.rules.account')}</Label>
            <Select value={accountId || undefined} onValueChange={setAccountId}>
              <SelectTrigger
                id="preview-account"
                className="h-11"
                aria-label={t('v3.categories.rules.account')}
              >
                <SelectValue placeholder={t('v3.categories.rules.chooseAccount')} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rule-month">{t('v3.categories.rules.period')}</Label>
            <Input
              id="rule-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-44"
            />
          </div>
          <Button
            variant="outline"
            disabled={!accountId || !month || makePreview.isPending}
            onClick={() => previewScope()}
          >
            {t('v3.categories.rules.preview')}
          </Button>
        </div>
        <p className="text-label text-muted-foreground">{t('v3.categories.rules.previewLimit')}</p>
      </div>
      <div className="space-y-3">
        <h3 className="text-body font-medium">{t('v3.categories.rules.recent')}</h3>
        <p className="text-label text-muted-foreground">{t('v3.categories.rules.retention')}</p>
        {recent.isLoading ? (
          <p role="status">{t('v3.categories.rules.loading')}</p>
        ) : recent.isError ? (
          <Button variant="outline" onClick={() => void recent.refetch()}>
            {t('v3.categories.rules.reload')}
          </Button>
        ) : (
          <ul className="divide-y divide-border">
            {(recent.data?.items ?? []).map((operation) => (
              <li
                key={operation.operationId}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="text-body">
                    {t(
                      operation.status === 'undone'
                        ? 'v3.categories.rules.restored'
                        : 'v3.categories.rules.applied',
                      { count: operation.changed }
                    )}
                  </p>
                  <p className="text-label text-muted-foreground">
                    {formatDateTime(operation.appliedAt)}
                  </p>
                </div>
                {operation.status === 'applied' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={undo.isPending}
                    onClick={() => {
                      setError(null);
                      undo.mutate({ operationId: operation.operationId });
                    }}
                  >
                    {t('v3.categories.rules.undo')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <CategoryRuleFormSheet
        draft={draft}
        accounts={accounts}
        onChange={onDraft}
        onClose={() => {
          onDraft(null);
          setError(null);
        }}
        onSave={() => {
          if (draft) save.mutate(draft);
        }}
        pending={pending}
        error={error}
      />
      <CategoryRulePreviewSheet
        preview={preview}
        pending={apply.isPending || makePreview.isPending}
        error={applyError}
        needsRefresh={needsRefresh}
        onClose={() => setPreview(null)}
        onApply={() => {
          if (preview) apply.mutate({ previewId: preview.previewId });
        }}
        onRefresh={() => {
          if (preview) previewScope(preview.scope);
        }}
      />
      <FormSheet
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleting(null);
        }}
        title={t('v3.categories.rules.deleteTitle')}
        description={t('v3.categories.rules.deleteDescription')}
        footer={
          <FormActions
            submitLabel={t('v3.categories.page.deleteAction')}
            pendingLabel={t('v3.categories.page.saving')}
            onSubmit={() => {
              if (deleting) remove.mutate({ id: deleting.id, expectedRevision: deleting.revision });
            }}
            onCancel={() => setDeleting(null)}
            blockers={[]}
            pending={pending}
            error={error}
          />
        }
      >
        <p className="break-words text-body">{deleting?.payeeKey}</p>
      </FormSheet>
    </section>
  );
}
