import type { DatabaseTransaction } from '@scani/db';
import type { JobNotice } from '@scani/providers/core/types';
import type { AssetResolution, AssetResolver } from '../AssetResolver';
import { assetKey } from '../asset-key';
import type { AssetRef, LegacyBatchOptions } from '../feed-batch';

type TokenMode = 'create' | 'find-only';

/** Only a find-only batch never creates a token; an update-only one creates no holding. */
export const tokenModeOf = (policy: LegacyBatchOptions['holdingPolicy']): TokenMode =>
  policy === 'find-only' ? 'find-only' : 'create';

/**
 * One batch's tokens, each asset resolved once per mode: a find-only miss
 * must not answer a create-on-miss lookup of the same token.
 */
export class BatchTokens {
  private readonly answers = new Map<string, { asset: AssetRef; answer: AssetResolution }>();

  constructor(private readonly resolver: AssetResolver) {}

  async resolve(asset: AssetRef, mode: TokenMode, tx: DatabaseTransaction | undefined) {
    const key = JSON.stringify([mode, assetKey(asset)]);
    if (!this.answers.has(key)) {
      this.answers.set(key, { asset, answer: await this.resolver.resolve(asset, mode, tx) });
    }
  }

  answerOf(asset: AssetRef, mode: TokenMode): AssetResolution | null {
    return this.answers.get(JSON.stringify([mode, assetKey(asset)]))?.answer ?? null;
  }

  tokenOf(asset: AssetRef | undefined, mode: TokenMode): string | null {
    const answer = asset === undefined ? null : this.answerOf(asset, mode);
    return answer !== null && 'tokenId' in answer ? answer.tokenId : null;
  }

  /**
   * One line per asset whose lookup threw, however many entries name it (R35).
   * The frame is keyed and the upstream message rides in it verbatim (SC-434).
   */
  failureNotices(): JobNotice[] {
    const lines = new Map<string, JobNotice>();
    for (const { asset, answer } of this.answers.values()) {
      if ('failed' in answer && !lines.has(assetKey(asset))) {
        const identity = asset.identity.symbol;
        lines.set(assetKey(asset), {
          key: 'v3.jobs.notices.tokenIdentityFailed',
          params: { identity, error: answer.failed },
          text: `Failed to resolve token identity ${identity}: ${answer.failed}`,
        });
      }
    }
    return [...lines.values()];
  }
}
