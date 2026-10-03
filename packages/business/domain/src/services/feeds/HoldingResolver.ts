import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import type { HoldingArrival } from '@scani/shared';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import type { LegacyBatchOptions } from './feed-batch';

interface FeedHoldingRequest {
  userId: string;
  accountId: string;
  tokenId: string;
  /** `holdings.external_id` on create. */
  key: string | null;
  match: LegacyBatchOptions['holdingMatch'];
  /** Null finds only. A null `arrival` leaves the column's own default. */
  create: { source: string; arrival: HoldingArrival | null } | null;
  /** The earliest instant the write carries for this holding. */
  at: Date;
}

/**
 * The one `holdings` INSERT on the paths A2 moves (D-4). A row starts with an
 * empty cache and no observation: its first value is the writer's to record,
 * labelled, and the writer then sets the cache (D-1).
 */
@Service()
export class HoldingResolver {
  private readonly holdingRepository = Container.get(HoldingRepository);

  /** A position a person keeps, starting at the write's instant (D-6). */
  async createSnapshotHolding(
    input: {
      userId: string;
      accountId: string;
      tokenId: string;
      label: string | null;
      source: string;
      /** Null leaves the column's own default. */
      arrival: HoldingArrival | null;
      at: Date;
    },
    tx: DatabaseTransaction
  ): Promise<Holding> {
    return await this.holdingRepository.create(
      {
        userId: input.userId,
        accountId: input.accountId,
        tokenId: input.tokenId,
        label: input.label,
        source: input.source,
        ...(input.arrival === null ? {} : { arrival: input.arrival }),
        balance: '0',
        kind: 'snapshot',
        startsAt: input.at,
        lastUpdated: new Date(),
      },
      tx
    );
  }

  /**
   * The holding a feed writes into, by the path's own matching (D-4), or one it
   * creates: a feed position starting at the write's earliest instant (D-6).
   * Null when there is none and `create` is null.
   */
  async resolveFeedHolding(
    req: FeedHoldingRequest,
    tx: DatabaseTransaction
  ): Promise<{ holding: Holding; created: boolean } | null> {
    const found = await this.findFeedHolding(req, tx);
    if (found) return { holding: found, created: false };
    if (req.create === null) return null;
    const holding = await this.holdingRepository.create(
      {
        userId: req.userId,
        accountId: req.accountId,
        tokenId: req.tokenId,
        source: req.create.source,
        ...(req.create.arrival === null ? {} : { arrival: req.create.arrival }),
        externalId: req.key,
        balance: '0',
        kind: 'feed',
        startsAt: req.at,
        lastUpdated: new Date(),
      },
      tx
    );
    return { holding, created: true };
  }

  /** The holding a feed writes into, by the path's own matching (D-4); never one it creates. */
  findFeedHolding(
    req: Pick<FeedHoldingRequest, 'userId' | 'accountId' | 'tokenId' | 'match'>,
    tx: DatabaseTransaction | undefined
  ): Promise<Holding | null> {
    switch (req.match) {
      // F1, the statement import's: the account's oldest visible holding of the token.
      case 'account-token':
        return this.holdingRepository.findByAccountAndToken(
          req.accountId,
          req.tokenId,
          req.userId,
          undefined,
          tx
        );
      // F2, the transaction import's (SC-193).
      case 'ingest-order':
        return this.holdingRepository.findForIngest(req.accountId, req.tokenId, req.userId, tx);
    }
  }
}
