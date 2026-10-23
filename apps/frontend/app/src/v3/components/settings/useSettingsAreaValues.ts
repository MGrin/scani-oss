import { formatDate } from '@scani/shared';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSignedInUser } from '@/contexts/auth-context';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import { useLocalPushEndpoint } from '../../lib/push-local';
import type { SettingsAreaValue } from '../../lib/settings-areas';

interface Read {
  data: unknown;
  isError: boolean;
  fetchStatus: string;
}

/**
 * Whether every read has answered. A read that failed, or is waiting for a
 * network that is not there, is `failed` rather than `reading`: its row then
 * stands without a value instead of holding a placeholder for good.
 */
function settle(...reads: Read[]): 'ready' | 'reading' | 'failed' {
  const open = reads.filter((read) => read.data === undefined);
  if (open.length === 0) return 'ready';
  return open.some((read) => read.isError || read.fetchStatus === 'paused') ? 'failed' : 'reading';
}

function rowValue(state: ReturnType<typeof settle>, text: () => string): SettingsAreaValue {
  if (state === 'ready') return text();
  return state === 'failed' ? null : undefined;
}

const join = (...parts: (string | null | undefined)[]) =>
  parts.filter((part): part is string => Boolean(part)).join(' · ');

/**
 * What each Settings area holds right now, for its row in the list (SC-1670,
 * bus #23834): most visits are to check a value, and the list should answer
 * without a tap. Every query is one its section already reads, so opening the
 * area afterwards costs no request.
 */
export function useSettingsAreaValues(): Record<string, SettingsAreaValue> {
  const { t } = useTranslation();
  const user = useSignedInUser();
  const currency = useBaseCurrency();
  const profile = trpc.users.getCurrent.useQuery();
  const costBasis = trpc.users.getCostBasisMethod.useQuery();
  const sessions = trpc.sessions.list.useQuery(undefined, { refetchOnWindowFocus: true });
  const backup = trpc.backups.latest.useQuery();
  // Whether THIS browser is subscribed, which is what the section's own switch
  // shows: the same cache entry, so the two always agree. `undefined` until it
  // has been read, and the row then says nothing about reminders rather than
  // guessing.
  const local = useLocalPushEndpoint().endpoint;
  const subscribed = local === undefined ? undefined : local !== null;

  const you = settle(profile, costBasis);
  return {
    you:
      you === 'ready' && !currency.isResolved && currency.isLoading
        ? undefined
        : rowValue(you, () =>
            join(
              profile.data?.name,
              // The context stands in `USD` until the real one resolves.
              currency.isResolved ? currency.symbol : null,
              costBasis.data && t(`v3.settings.costBasis.methodShort.${costBasis.data.method}`)
            )
          ),
    notifications: rowValue(settle(sessions), () =>
      join(
        subscribed === undefined
          ? null
          : subscribed
            ? t('v3.settings.areas.notifications.remindersOn')
            : t('v3.settings.areas.notifications.remindersOff'),
        t('v3.settings.areas.notifications.devices', { count: sessions.data?.length ?? 0 })
      )
    ),
    data: rowValue(settle(backup), () =>
      backup.data
        ? t('v3.settings.areas.data.lastBackup', { date: formatDate(backup.data.createdAt) })
        : t('v3.settings.areas.data.noBackup')
    ),
    account: user?.email ?? null,
  };
}

/**
 * The AI agents area. Listed while access is on, and also while an app is
 * still connected or an agent has left something behind: the server keeps
 * those readable with access off, because a person must always be able to see
 * and cut off what can read their data.
 */
export function useAgentsArea(): {
  listed: boolean;
  /** Whether `listed` is the final answer, rather than "not yet known". */
  known: boolean;
  empty: boolean;
  value: SettingsAreaValue;
} {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const access = trpc.agentTokens.status.useQuery();
  // Asked beside `status`, not after it: a round trip later put the token rows
  // past the area's reveal, and they pushed the sections below down 66 px
  // (SC-1743). With access off the server refuses it once, and nothing waits.
  useEffect(() => {
    void utils.agentTokens.list.prefetch(undefined, { retry: false });
  }, [utils]);
  const apps = trpc.agentTokens.connectedApps.useQuery();
  const activity = trpc.agentTokens.activity.useQuery();
  const calls = trpc.agentTokens.calls.useQuery();
  const on = access.data?.enabled === true;
  const keys = trpc.agentTokens.list.useQuery(undefined, { enabled: on });
  const used = [apps, activity, calls].some((read) => (read.data?.length ?? 0) > 0);
  const answered = settle(access, apps, activity, calls) !== 'reading';

  return {
    listed: on || used,
    known: on || used || answered,
    empty: !on && !used && answered,
    value: on
      ? rowValue(settle(keys), () =>
          t('v3.settings.areas.agents.keys', { count: keys.data?.length ?? 0 })
        )
      : null,
  };
}
