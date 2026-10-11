import { Block } from '@scani/ui/v3/components/Block';
import { Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useRelativeTimeTick } from '@/v3/hooks/useRelativeTimeTick';
import { formatRelative } from '../../lib/relative-time';

/**
 * Every tool call the user's AI agents made (SC-1618), refused and failed ones
 * included. Hidden until an agent has called something.
 */
export function AgentCallsSettings() {
  const { t } = useTranslation();
  const calls = trpc.agentTokens.calls.useQuery();
  if (!calls.data?.length) return null;
  return (
    <Block className="flex flex-col">
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.agentCalls.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.agentCalls.intro')}</p>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {calls.data.map((call) => (
          <AgentCallRow key={call.id} call={call} />
        ))}
      </ul>
    </Block>
  );
}

interface AgentCallRowProps {
  call: {
    tool: string;
    argsSummary: string;
    outcome: string;
    actorName: string | null;
    createdAt: string | Date;
  };
}

function AgentCallRow({ call }: AgentCallRowProps) {
  useRelativeTimeTick();
  const { t } = useTranslation();
  const parts = [
    formatRelative(t, call.createdAt),
    call.actorName ?? t('v3.settings.agentCalls.removedAgent'),
  ];
  if (call.outcome === 'error') parts.push(t('v3.settings.agentCalls.outcomeError'));
  if (call.outcome === 'refused') parts.push(t('v3.settings.agentCalls.outcomeRefused'));
  return (
    <li className="flex items-start gap-3 px-4 py-2">
      <Terminal className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-label">{call.tool}</p>
        <p className="truncate text-caption text-muted-foreground">{parts.join(' · ')}</p>
        {call.argsSummary !== '{}' ? (
          <p className="truncate font-mono text-caption text-muted-foreground">
            {call.argsSummary}
          </p>
        ) : null}
      </div>
    </li>
  );
}
