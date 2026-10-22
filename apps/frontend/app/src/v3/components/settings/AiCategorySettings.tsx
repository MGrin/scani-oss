import { Switch } from '@scani/ui/ui/switch';
import { showError } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';

/**
 * AI category suggestions, off until the person turns them on (SC-1695). What
 * leaves for the AI provider is stated beside the switch, on or off.
 */
export function AiCategorySettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const state = trpc.users.getAiCategories.useQuery();
  const set = trpc.users.setAiCategories.useMutation({
    onError: (error) => showError(error, t('v3.settings.aiCategories.saving')),
    onSettled: () => void utils.users.getAiCategories.invalidate(),
  });
  const available = state.data?.available ?? false;
  const on = set.isPending ? (set.variables?.enabled ?? false) : (state.data?.enabled ?? false);

  return (
    <Block className="flex flex-col gap-3 p-4">
      <h2 className="text-label text-muted-foreground">{t('v3.settings.aiCategories.title')}</h2>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="ai-categories" className="text-body">
          {t('v3.settings.aiCategories.label')}
        </label>
        <Switch
          id="ai-categories"
          checked={on}
          // Turning it off is always allowed: withdrawing consent needs no provider.
          disabled={!state.data || set.isPending || (!available && !on)}
          onCheckedChange={(enabled) => set.mutate({ enabled })}
        />
      </div>
      <p className="text-caption text-muted-foreground">{t('v3.settings.aiCategories.sent')}</p>
      {state.data && !available ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.settings.aiCategories.unavailable')}
        </p>
      ) : null}
    </Block>
  );
}
