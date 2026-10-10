import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { History } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useRelativeTimeTick } from '@/v3/hooks/useRelativeTimeTick';
import { formatRelative } from '../../lib/relative-time';

/**
 * What the user's AI agents changed (SC-1617), each with an undo that puts
 * every row back. Hidden until an agent has changed something.
 */
export function AgentActivitySettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const activity = trpc.agentTokens.activity.useQuery();
  const undo = trpc.agentTokens.undoWrite.useMutation({
    onSuccess: () => {
      showSuccess(t('v3.settings.agentActivity.undone'));
      void utils.invalidate();
    },
    onError: (error) => showError(error, t('v3.settings.agentActivity.undoing')),
    onSettled: () => void utils.agentTokens.activity.invalidate(),
  });

  if (!activity.data?.length) return null;

  return (
    <Block className="flex flex-col">
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.agentActivity.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.agentActivity.intro')}</p>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {activity.data.map((change) => (
          <AgentChangeRow
            key={change.id}
            change={change}
            isPending={undo.isPending}
            onUndo={() => undo.mutate({ id: change.id })}
          />
        ))}
      </ul>
    </Block>
  );
}

interface AgentChangeRowProps {
  change: {
    tool: string;
    status: string;
    changeCount: number;
    createdAt: string | Date;
    undoneAt: string | Date | null;
  };
  isPending: boolean;
  onUndo: () => void;
}

function AgentChangeRow({ change, isPending, onUndo }: AgentChangeRowProps) {
  useRelativeTimeTick();
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const toolKey = `v3.settings.agentActivity.tools.${change.tool}`;
  const label = i18n.exists(toolKey) ? t(toolKey) : change.tool;
  const state =
    change.status === 'undone' && change.undoneAt
      ? t('v3.settings.agentActivity.statusUndone', {
          when: formatRelative(t, change.undoneAt),
        })
      : change.status === 'failed'
        ? t('v3.settings.agentActivity.statusFailed')
        : t('v3.settings.agentActivity.rows', { count: change.changeCount });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
      <History className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label">{label}</p>
        <p className="truncate text-caption text-muted-foreground">
          {formatRelative(t, change.createdAt)} · {state}
        </p>
      </div>
      {change.status === 'applied' ? (
        <ConfirmAction
          label={t('v3.settings.agentActivity.undo')}
          confirmLabel={t('v3.settings.agentActivity.undoConfirm')}
          consequence={t('v3.settings.agentActivity.undoConsequence')}
          open={confirming}
          onOpenChange={setConfirming}
          isPending={isPending}
          onConfirm={onUndo}
        />
      ) : null}
    </li>
  );
}
