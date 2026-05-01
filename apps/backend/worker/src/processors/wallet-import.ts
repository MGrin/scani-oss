import { ImportWalletAddressUseCase } from '@scani/domain/use-cases';
import { WALLET_IMPORT, type WalletImportJob } from '@scani/jobs';
import { type ProcessorContext, UnrecoverableError, UserJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

@Service()
export class WalletImportProcessor extends UserJobProcessor<WalletImportJob, unknown> {
  readonly descriptor = WALLET_IMPORT;

  /**
   * Wallet-import is now a two-step flow. This processor handles only
   * the *prepare* phase: detect chains + fetch balances. The result is
   * a `needsReview` payload listing every detected token; the user
   * picks which to keep on the job-detail page, then the
   * `walletImport.confirmHoldings` mutation runs the actual import for
   * the approved subset (creating accounts + holdings, warming prices,
   * enqueueing transaction-import + history-backfill).
   *
   * Why split: blockchain wallets routinely contain hundreds of spam /
   * airdrop / scam tokens. Auto-creating holdings forced the user to
   * delete each manually. The hourly `wallet-balances` repeatable cron
   * is a different processor and continues to auto-sync the holdings
   * the user has already kept — review only applies to user-initiated
   * imports.
   */
  protected async handle(data: WalletImportJob, _ctx: ProcessorContext): Promise<unknown> {
    const review = await Container.get(ImportWalletAddressUseCase).prepareReview(
      {
        address: data.address,
        displayName: data.label,
        detectedInstitutionIds: data.detectedInstitutionIds,
      },
      data.userId
    );

    const totalSnapshots = review.chains.reduce((acc, c) => acc + c.snapshots.length, 0);
    if (review.chainsDetected === 0 && review.errors.length > 0) {
      const summary = review.errors.map((e) => e.error).join('; ');
      throw new UnrecoverableError(`Wallet import produced no chains; errors: ${summary}`);
    }

    return {
      needsReview: true,
      walletLabel: review.walletLabel,
      walletId: review.walletId,
      address: data.address,
      displayName: data.label,
      userBaseCurrencyId: review.userBaseCurrencyId,
      cryptoTokenTypeId: review.cryptoTokenTypeId,
      walletAccountTypeId: review.walletAccountTypeId,
      chains: review.chains,
      chainsDetected: review.chainsDetected,
      candidateCount: totalSnapshots,
      errors: review.errors,
    };
  }
}
