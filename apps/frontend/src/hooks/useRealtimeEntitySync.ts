import { useCallback, useMemo } from 'react';
import {
  invalidateAccountsRelated,
  invalidateHoldingsRelated,
  invalidateInstitutionsRelated,
  invalidateTokensRelated,
  invalidateTransactionsRelated,
} from '@/lib/cache/invalidateHoldingsRelated';
import { trpc } from '@/lib/trpc';
import { useScaniWebSocket, type WebSocketMessage } from './useWebSocket';

type EntityType = 'institution' | 'account' | 'holding' | 'transaction' | 'token' | 'user';
type OperationType = 'create' | 'update' | 'delete' | 'sync';

interface EntityChangedMessage extends WebSocketMessage {
  entityType?: EntityType;
  operationType?: OperationType;
  entityId?: string;
  entityIds?: string[];
  data?: Record<string, unknown>;
  metadata?: {
    relatedEntities?: Array<{
      type: EntityType;
      id: string;
    }>;
  };
}

function resolveWebSocketUrl() {
  const explicitUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicitUrl) {
    return explicitUrl;
  }

  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';
  const parsed = new URL(apiUrl);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.port = String(port + 1);
  parsed.pathname = '';
  parsed.search = '';

  return parsed.toString();
}

export function useRealtimeEntitySync() {
  const utils = trpc.useUtils();

  const websocketUrl = useMemo(() => resolveWebSocketUrl(), []);

  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.type !== 'entity_changed') {
        return;
      }

      const payload = message as EntityChangedMessage;
      const entityType = payload.entityType;

      if (!entityType) {
        return;
      }

      const entityId = payload.entityId;
      const related = payload.metadata?.relatedEntities ?? [];
      const data = payload.data ?? {};

      switch (entityType) {
        case 'account':
          void invalidateAccountsRelated(utils, {
            includePortfolioValue: true,
            accountIds: entityId ? [entityId] : [],
          });
          if (related.length) {
            const institutionIds = related
              .filter((entity) => entity.type === 'institution')
              .map((entity) => entity.id);
            if (institutionIds.length) {
              void invalidateInstitutionsRelated(utils, {
                includeAccounts: true,
                institutionIds,
              });
            }
          } else if (typeof data === 'object' && data && 'institutionId' in data) {
            const institutionId = data.institutionId;
            if (typeof institutionId === 'string') {
              void invalidateInstitutionsRelated(utils, {
                includeAccounts: true,
                institutionIds: [institutionId],
              });
            }
          }
          break;
        case 'institution':
          void invalidateInstitutionsRelated(utils, {
            includeAccounts: true,
            institutionIds: entityId ? [entityId] : [],
          });
          break;
        case 'holding':
          void invalidateHoldingsRelated(utils, {
            holdingIds: entityId ? [entityId] : [],
          });
          if (related.length) {
            const accountIds = related
              .filter((entity) => entity.type === 'account')
              .map((entity) => entity.id);
            if (accountIds.length) {
              void invalidateAccountsRelated(utils, {
                includeSummaries: false,
                accountIds,
              });
            }
          } else if (typeof data === 'object' && data && 'accountId' in data) {
            const accountId = data.accountId;
            if (typeof accountId === 'string') {
              void invalidateAccountsRelated(utils, {
                includeSummaries: false,
                accountIds: [accountId],
              });
            }
          }
          break;
        case 'transaction':
          void invalidateTransactionsRelated(utils);
          {
            const holdingIdsFromMetadata = related
              .filter((entity) => entity.type === 'holding')
              .map((entity) => entity.id);
            if (holdingIdsFromMetadata.length) {
              void invalidateHoldingsRelated(utils, {
                holdingIds: holdingIdsFromMetadata,
              });
            } else if (typeof data === 'object' && data && 'holdingId' in data) {
              const holdingId = data.holdingId;
              if (typeof holdingId === 'string') {
                void invalidateHoldingsRelated(utils, {
                  holdingIds: [holdingId],
                });
              }
            }
          }
          break;
        case 'token':
          void invalidateTokensRelated(utils);
          break;
        default:
          break;
      }
    },
    [utils]
  );

  return useScaniWebSocket({
    url: websocketUrl,
    onMessage: handleMessage,
  });
}
