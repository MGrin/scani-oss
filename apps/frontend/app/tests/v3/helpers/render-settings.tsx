import '../../i18n-preload';
import './api-env';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { Circle } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Route, Routes, StaticRouter, useParams } from 'react-router-dom';
import type { AuthContextType } from '../../../src/contexts/AuthContext';
import { AuthContext } from '../../../src/contexts/auth-context';
import { BaseCurrencyProvider } from '../../../src/contexts/BaseCurrencyContext';
import { trpc } from '../../../src/lib/trpc';
import { AgentsSections } from '../../../src/v3/components/settings/AgentsSections';
import { SettingsAreas } from '../../../src/v3/components/settings/SettingsAreas';
import type { SettingsArea } from '../../../src/v3/lib/settings-areas';

export const SETTINGS_USER = { id: 'user-1', email: 'ivy@example.test', name: 'Ivy Calder' };

/** A read that answered, keyed as the page asks for it. */
export const SETTINGS_KEYS = {
  profile: getQueryKey(trpc.users.getCurrent, undefined, 'query'),
  costBasis: getQueryKey(trpc.users.getCostBasisMethod, undefined, 'query'),
  baseCurrency: getQueryKey(trpc.users.getBaseCurrency, undefined, 'query'),
  sessions: getQueryKey(trpc.sessions.list, undefined, 'query'),
  backup: getQueryKey(trpc.backups.latest, undefined, 'query'),
  agentAccess: getQueryKey(trpc.agentTokens.status, undefined, 'query'),
  agentKeys: getQueryKey(trpc.agentTokens.list, undefined, 'query'),
  connectedApps: getQueryKey(trpc.agentTokens.connectedApps, undefined, 'query'),
  agentActivity: getQueryKey(trpc.agentTokens.activity, undefined, 'query'),
  agentCalls: getQueryKey(trpc.agentTokens.calls, undefined, 'query'),
} satisfies Record<string, QueryKey>;

const stub = (id: string): SettingsArea => ({
  id,
  icon: Circle,
  titleKey: `v3.settings.areas.${id}.title`,
  sections: () => <p>{`sections of ${id}`}</p>,
});

/**
 * The page's areas with their forms stubbed out: `ProfileSettings` reaches the
 * Vite-only locale loader, which `bun test` cannot import. The agents area is
 * the real one, because what it shows is part of what is tested.
 */
export const TEST_AREAS: SettingsArea[] = [
  stub('you'),
  stub('notifications'),
  { ...stub('agents'), sections: () => <AgentsSections /> },
  stub('data'),
  stub('account'),
];

function Page({ areas }: { areas: SettingsArea[] }) {
  return <SettingsAreas areas={areas} areaId={useParams().area} />;
}

/** An account with every list read answered, agent access off and nothing connected. */
export function settledSettings(): [QueryKey, unknown][] {
  return [
    [SETTINGS_KEYS.profile, { name: SETTINGS_USER.name, baseCurrencyId: 'gbp-id' }],
    [SETTINGS_KEYS.costBasis, { method: 'uk_section_104' }],
    [SETTINGS_KEYS.baseCurrency, { id: 'gbp-id', symbol: 'GBP', name: 'Pound sterling' }],
    [SETTINGS_KEYS.sessions, [{ id: 's1' }, { id: 's2' }]],
    [SETTINGS_KEYS.backup, null],
    [SETTINGS_KEYS.agentAccess, { enabled: false }],
    [SETTINGS_KEYS.connectedApps, []],
    [SETTINGS_KEYS.agentActivity, []],
    [SETTINGS_KEYS.agentCalls, []],
  ];
}

/**
 * The Settings page at `path` over a cache holding `answered`, with every key
 * in `failed` left in the error state. Nothing fetches: a static render runs no
 * effect, and a read with no entry stays loading.
 */
export function renderSettings(
  path: string,
  {
    answered,
    failed = [],
    areas = TEST_AREAS,
  }: { answered: [QueryKey, unknown][]; failed?: QueryKey[]; areas?: SettingsArea[] }
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  for (const [key, data] of answered) client.setQueryData(key, data);
  for (const queryKey of failed) {
    client
      .getQueryCache()
      .build(client, { queryKey })
      .setState({ status: 'error', error: new Error('unreachable'), fetchStatus: 'idle' });
  }
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  const auth = { user: SETTINGS_USER, status: 'authenticated' } as unknown as AuthContextType;
  const html = renderToStaticMarkup(
    <trpc.Provider client={trpcClient} queryClient={client}>
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={auth}>
          <BaseCurrencyProvider>
            <StaticRouter location={path}>
              <Routes>
                <Route path="/settings/:area?" element={<Page areas={areas} />} />
              </Routes>
            </StaticRouter>
          </BaseCurrencyProvider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </trpc.Provider>
  );
  client.clear();
  return html;
}
