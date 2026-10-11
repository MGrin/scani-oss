import { Button } from '@scani/ui/ui/button';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { Input } from '@scani/ui/ui/input';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { Bot } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiBaseUrl } from '@/lib/api-base-url';
import { trpc } from '@/lib/trpc';
import { useRelativeTimeTick } from '@/v3/hooks/useRelativeTimeTick';
import { formatRelative } from '../../lib/relative-time';

/**
 * Personal access tokens for the user's own AI agent (SC-1614): create one,
 * copy it once, revoke it. Rendered only while agent access is on for this
 * account; the server refuses every write here when it is off.
 */
export function AgentTokensSettings() {
  const status = trpc.agentTokens.status.useQuery();
  if (!status.data?.enabled) return null;
  return <AgentTokensBlock />;
}

function mcpUrl(): string {
  return new URL('/mcp', `${apiBaseUrl().replace(/\/$/, '')}/`).toString();
}

function AgentTokensBlock() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const tokens = trpc.agentTokens.list.useQuery();

  const create = trpc.agentTokens.create.useMutation({
    onSuccess: (created) => {
      setMinted(created.token);
      setName('');
      setAllowWrites(false);
    },
    onError: (error) => showError(error, t('v3.settings.agentTokens.creating')),
    onSettled: () => void utils.agentTokens.list.invalidate(),
  });

  const revoke = trpc.agentTokens.revoke.useMutation({
    onSuccess: () => showSuccess(t('v3.settings.agentTokens.revoked')),
    onError: (error) => showError(error, t('v3.settings.agentTokens.revoking')),
    onSettled: () => void utils.agentTokens.list.invalidate(),
  });

  const command = minted
    ? `claude mcp add --transport http scani ${mcpUrl()} --header "Authorization: Bearer ${minted}"`
    : '';

  return (
    <Block className="flex flex-col">
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.agentTokens.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.agentTokens.intro')}</p>
      </div>

      <form
        className="flex flex-wrap gap-2 px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate({ name: name.trim(), allowWrites });
        }}
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('v3.settings.agentTokens.namePlaceholder')}
          aria-label={t('v3.settings.agentTokens.nameLabel')}
          maxLength={60}
        />
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {t('v3.settings.agentTokens.create')}
        </Button>
        <label htmlFor="agent-token-allow-writes" className="flex w-full items-start gap-2">
          <Checkbox
            id="agent-token-allow-writes"
            className="mt-0.5"
            checked={allowWrites}
            onCheckedChange={(checked) => setAllowWrites(checked === true)}
          />
          <span className="flex flex-col">
            <span className="text-body">{t('v3.settings.agentTokens.allowWrites')}</span>
            <span className="text-caption text-muted-foreground">
              {t('v3.settings.agentTokens.allowWritesHint')}
            </span>
          </span>
        </label>
      </form>

      {minted ? (
        <div className="mx-4 mb-4 flex flex-col gap-2 rounded-md border border-border p-3">
          <p className="text-body">{t('v3.settings.agentTokens.copyOnce')}</p>
          <code className="break-all text-caption">{minted}</code>
          <p className="text-caption text-muted-foreground">
            {t('v3.settings.agentTokens.claudeCode')}
          </p>
          <code className="break-all text-caption">{command}</code>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(command)
                  .then(() => showSuccess(t('v3.settings.agentTokens.copied')))
              }
            >
              {t('v3.settings.agentTokens.copyCommand')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMinted(null)}>
              {t('v3.settings.agentTokens.done')}
            </Button>
          </div>
        </div>
      ) : null}

      {tokens.isError ? (
        <div className="p-4 pt-0">
          <QueryError
            error={tokens.error}
            subject={t('v3.settings.agentTokens.subject')}
            onRetry={() => void tokens.refetch()}
          />
        </div>
      ) : tokens.isLoading ? (
        <div className="p-4 pt-0">
          <Skeleton className="h-10 w-full" aria-hidden="true" />
        </div>
      ) : (tokens.data ?? []).length === 0 ? (
        <p className="p-4 pt-0 text-body text-muted-foreground">
          {t('v3.settings.agentTokens.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {(tokens.data ?? []).map((token) => (
            <AgentTokenRow
              key={token.id}
              token={token}
              isPending={revoke.isPending}
              onRevoke={() => revoke.mutate({ id: token.id })}
            />
          ))}
        </ul>
      )}
    </Block>
  );
}

interface AgentTokenRowProps {
  token: { name: string; tokenPrefix: string; scopes: string[]; lastUsedAt: string | Date | null };
  isPending: boolean;
  onRevoke: () => void;
}

function AgentTokenRow({ token, isPending, onRevoke }: AgentTokenRowProps) {
  useRelativeTimeTick();
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
      <Bot className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label">{token.name}</p>
        <p className="truncate text-caption text-muted-foreground">
          {token.lastUsedAt
            ? t('v3.settings.agentTokens.lastUsed', {
                prefix: token.tokenPrefix,
                when: formatRelative(t, token.lastUsedAt),
              })
            : t('v3.settings.agentTokens.neverUsed', { prefix: token.tokenPrefix })}
          {token.scopes.includes('portfolio:write')
            ? ` · ${t('v3.settings.agentTokens.canWrite')}`
            : null}
        </p>
      </div>
      <ConfirmAction
        label={t('v3.settings.agentTokens.revoke')}
        triggerClassName="text-destructive hover:text-destructive"
        destructive
        confirmLabel={t('v3.settings.agentTokens.revokeConfirm', { name: token.name })}
        consequence={t('v3.settings.agentTokens.revokeConsequence')}
        open={confirming}
        onOpenChange={setConfirming}
        isPending={isPending}
        onConfirm={onRevoke}
      />
    </li>
  );
}
