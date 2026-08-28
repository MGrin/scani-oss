import type { HoldingWithDetails } from '@scani/shared';
import { formatDateTime, quantityDecimals } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { CheckCircle2, EyeOff, History, Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { useHoldingActions } from '../../hooks/useHoldingActions';
import { V3_CAPTURE_ROUTES, V3_ROUTES } from '../../lib/routes';
import { isScamToken } from '../../lib/tokens';
import {
  deriveWalletSelection,
  initialWalletSelection,
  readWalletImport,
  type WalletCandidate,
  type WalletChainGroup,
  type WalletImportView,
} from '../../lib/wallet-import';
import { DiscardedReviewCard } from './DiscardedReviewCard';
import { JobIssueList } from './JobIssueList';

/**
 * What reading a wallet address found, and the decision about what to keep.
 *
 * Three payload shapes reach this, and telling them apart is the whole job:
 *
 * 1. **A review** — balances fetched, nothing written, the reader picks. This
 *    is every wallet import since the review-aware refactor.
 * 2. **A review whose candidates did not survive** to the job row (past the
 *    durable size cap, or an older worker). It says what is unknown rather than
 *    showing a zero — falling through to 3 here is what told someone holding
 *    2,766 tokens that a provider had rejected their fetch (SC-145).
 * 3. **An import that already ran** — the pre-review shape, where holdings were
 *    created and the review is pruning them. Old jobs still render.
 */
export function WalletImportResult({
  result,
  jobId,
  actionTakenAt,
  reviewOutcome,
}: {
  result: unknown;
  jobId: string;
  actionTakenAt?: Date | string | null;
  reviewOutcome?: string | null;
}) {
  if (reviewOutcome === 'discarded') {
    return <DiscardedReviewCard actionTakenAt={actionTakenAt} subject="wallet" />;
  }

  const view: WalletImportView = readWalletImport(result);

  if (view.kind === 'unavailable') {
    return <WalletReviewUnavailable view={view} />;
  }
  if (view.kind === 'review') {
    return <WalletReviewPicker view={view} jobId={jobId} actionTakenAt={actionTakenAt} />;
  }
  return <WalletImportedHoldings view={view} jobId={jobId} actionTakenAt={actionTakenAt} />;
}

/** The stamp every branch renders once the reader has finished with the job. */
function whenLabel(actionTakenAt?: Date | string | null): string | null {
  if (!actionTakenAt) return null;
  const when = actionTakenAt instanceof Date ? actionTakenAt : new Date(String(actionTakenAt));
  return Number.isNaN(when.getTime()) ? null : formatDateTime(when);
}

function ChainErrors({ lines }: { lines: readonly string[] }) {
  const { t } = useTranslation();
  return (
    <JobIssueList
      title={t('v3.jobs.wallet.chainsFailed', { count: lines.length })}
      lines={lines}
      note={t('v3.jobs.wallet.chainsFailedNote')}
    />
  );
}

function WalletReviewUnavailable({
  view,
}: {
  view: Extract<WalletImportView, { kind: 'unavailable' }>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <BlockHeader title={t('v3.jobs.wallet.unavailable.title')} />
        {/* Two figures rather than a sentence assembled around them: what is
            known is that the address was read and how much it held, and both
            are numbers a locale formats. */}
        <DataRowList className="border-t border-border">
          <DataRow
            label={t('v3.jobs.wallet.chainsRead')}
            value={<Numeric value={view.chainsDetected} format="plain" decimals={0} />}
          />
          <DataRow
            label={t('v3.jobs.wallet.tokensFound')}
            value={<Numeric value={view.candidateCount} format="plain" decimals={0} />}
          />
        </DataRowList>
        <p className="border-t border-border p-4 text-body text-muted-foreground">
          {t('v3.jobs.wallet.unavailable.body')}
        </p>
        <div className="border-t border-border p-4">
          <Button asChild variant="outline">
            <Link to={V3_CAPTURE_ROUTES.walletImport}>{t('v3.jobs.wallet.importAgain')}</Link>
          </Button>
        </div>
      </Block>
      <ChainErrors lines={view.errors} />
    </div>
  );
}

/**
 * Pick which detected balances become holdings.
 *
 * The one thing that is not v2's: **the filter cannot hide a row the button
 * will write.** v2's "Hide likely spam" removes rows from the list without
 * touching the selection, so ticking everything with the filter off and then
 * turning it back on offers "Import 31 holdings" over a list of nine, and the
 * twenty-two are named nowhere. The count is still the payload here — a filter
 * is a view, not an edit — and when the two diverge the card says so and offers
 * the way to look.
 */
function WalletReviewPicker({
  view,
  jobId,
  actionTakenAt,
}: {
  view: Extract<WalletImportView, { kind: 'review' }>;
  jobId: string;
  actionTakenAt?: Date | string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const hideSpamId = useId();
  const rowIdPrefix = useId();

  const [selected, setSelected] = useState<Set<string>>(() => initialWalletSelection(view.chains));
  const [hideSpam, setHideSpam] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const confirm = trpc.wallet.confirmHoldings.useMutation({
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.jobs.wallet.subject'), 'create');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
    onSuccess: async (data) => {
      showSuccess(t('v3.jobs.wallet.toast.imported', { count: data.holdingsCreated }));
      await Promise.all([
        utils.jobs.getMine.invalidate({ jobId }),
        utils.jobs.listMine.invalidate(),
        utils.review.listPending.invalidate(),
        invalidatePortfolioQueries(utils, { refetchType: 'all' }),
      ]);
      navigate(V3_ROUTES.holdings);
    },
  });

  const stamped = whenLabel(actionTakenAt);
  const selection = deriveWalletSelection(view.chains, selected, hideSpam);

  if (actionTakenAt) {
    return (
      <div className="flex flex-col gap-4">
        <Block className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-title">{t('v3.jobs.wallet.confirmed.title')}</h2>
          </div>
          {stamped ? (
            <p className="text-caption text-muted-foreground">
              {t('v3.jobs.wallet.confirmed.when', { when: stamped })}
            </p>
          ) : null}
          {/* No count. What was actually written is recorded on the holdings
              this job handed off to, not on the list it offered — v2 states the
              extracted figure here and is wrong for anyone who unticked a row
              (the same defect SC-133 fixed for the screenshot header). */}
          <p className="text-body text-muted-foreground">{t('v3.jobs.wallet.confirmed.body')}</p>
          <Button asChild variant="outline" className="mt-1 self-start">
            <Link to={V3_ROUTES.holdings}>{t('v3.jobs.review.viewHoldings')}</Link>
          </Button>
        </Block>
        <ChainErrors lines={view.errors} />
      </div>
    );
  }

  const toggle = (key: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <BlockHeader title={t(`v3.jobs.wallet.outcome.${view.outcome}`)} />
        <DataRowList className="border-t border-border">
          <DataRow
            label={t('v3.jobs.wallet.chainsDetected')}
            value={<Numeric value={view.chainsDetected} format="plain" decimals={0} />}
          />
          <DataRow
            label={t('v3.jobs.wallet.tokensFound')}
            value={<Numeric value={view.totalCandidates} format="plain" decimals={0} />}
          />
        </DataRowList>
        {/* One sentence per outcome, not a sentence assembled from figures the
            rows above already state. `empty` and `unreadable` are opposite
            answers about somebody's money and each gets its own (SC-139). */}
        <p className="border-t border-border p-4 text-body text-muted-foreground">
          {t(`v3.jobs.wallet.outcomeBody.${view.outcome}`)}
        </p>
      </Block>

      <ChainErrors lines={view.errors} />

      {view.totalCandidates > 0 ? (
        <Block className="flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            {view.spamCount > 0 ? (
              // A `<label htmlFor>` and Radix's own `<button role="checkbox">`,
              // never a button wrapping a button: the nested pair v2 shipped
              // put a control inside a control in the accessibility tree and
              // left a `pointer-events-none` inner one in the tab order, so
              // keyboard focus landed on something that could not be operated
              // (SC-141).
              <div className="flex items-center gap-2">
                <Checkbox
                  id={hideSpamId}
                  checked={hideSpam}
                  onCheckedChange={(value) => setHideSpam(value === true)}
                  disabled={confirm.isPending}
                />
                <label htmlFor={hideSpamId} className="cursor-pointer select-none text-label">
                  {t('v3.jobs.wallet.hideSpam', { count: view.spamCount })}
                </label>
              </div>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={confirm.isPending}
                onClick={() =>
                  // Only what is on screen: "tick everything I can see" is the
                  // sentence the control is read as, and adding hidden rows to
                  // the payload from a control the reader used on a filtered
                  // list is the divergence this card exists to prevent.
                  setSelected((previous) => {
                    const next = new Set(previous);
                    for (const chain of selection.groups) {
                      for (const row of chain.candidates) next.add(row.key);
                    }
                    return next;
                  })
                }
              >
                {t('v3.jobs.wallet.selectAll')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={confirm.isPending}
                onClick={() => setSelected(new Set())}
              >
                {t('v3.jobs.wallet.selectNone')}
              </Button>
            </div>
          </div>

          {selection.groups.map((chain) => (
            <ChainCandidates
              key={chain.institutionId}
              chain={chain}
              rowIdPrefix={rowIdPrefix}
              selected={selected}
              onToggle={toggle}
              disabled={confirm.isPending}
            />
          ))}

          <div className="flex flex-col gap-2 border-t border-border p-4">
            {/* The rows the button would write and the list does not show. v2
                counts them into "Import N holdings" and names them nowhere. */}
            {selection.hiddenSelected.length > 0 ? (
              <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                <EyeOff className="size-4 shrink-0" aria-hidden="true" />
                {t('v3.jobs.wallet.hiddenSelected', { count: selection.hiddenSelected.length })}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => setHideSpam(false)}
                >
                  {t('v3.jobs.wallet.showHidden')}
                </Button>
              </p>
            ) : null}
            {failure ? (
              <p role="alert" className="text-caption text-destructive">
                {failure}
              </p>
            ) : null}
            {selection.kept.length === 0 ? (
              <p className="text-caption text-muted-foreground">
                {t('v3.form.blockers', { blockers: t('v3.jobs.wallet.blocker.nothingPicked') })}
              </p>
            ) : (
              <p className="text-caption text-muted-foreground">
                {t('v3.jobs.wallet.afterConfirm')}
              </p>
            )}
            <Button
              className="w-full"
              disabled={selection.kept.length === 0 || confirm.isPending}
              onClick={() => {
                setFailure(null);
                confirm.mutate({ pickerJobId: jobId, kept: selection.kept });
              }}
            >
              {confirm.isPending ? (
                <>
                  <Loader2 className="me-2 size-4 animate-spin" aria-hidden="true" />
                  {t('v3.jobs.wallet.importing')}
                </>
              ) : (
                t('v3.jobs.wallet.import', { count: selection.kept.length })
              )}
            </Button>
          </div>
        </Block>
      ) : null}
    </div>
  );
}

function ChainCandidates({
  chain,
  rowIdPrefix,
  selected,
  onToggle,
  disabled,
}: {
  chain: WalletChainGroup;
  rowIdPrefix: string;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col border-t border-border">
      <h3 className="px-4 pt-4 pb-2 text-label text-muted-foreground">{chain.institutionName}</h3>
      <DataRowList>
        {chain.candidates.map((row) => (
          <CandidateRow
            key={row.key}
            row={row}
            rowId={`${rowIdPrefix}-${row.key}`}
            checked={selected.has(row.key)}
            onToggle={() => onToggle(row.key)}
            disabled={disabled}
          />
        ))}
      </DataRowList>
    </div>
  );
}

function CandidateRow({
  row,
  rowId,
  checked,
  onToggle,
  disabled,
}: {
  row: WalletCandidate;
  rowId: string;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <DataRow
      leading={
        <Checkbox id={rowId} checked={checked} onCheckedChange={onToggle} disabled={disabled} />
      }
      label={
        // The label carries the click to the checkbox it names, so the whole
        // row is a hit target without a second control wrapping the first.
        <label htmlFor={rowId} className="flex min-w-0 cursor-pointer items-center gap-1.5">
          <span className="font-medium">{row.symbol ?? row.externalId}</span>
          {row.name && row.name !== row.symbol ? (
            <span className="min-w-0 truncate text-muted-foreground">{row.name}</span>
          ) : null}
          {row.spam ? (
            // The REASON, not a warning triangle. A row that arrived unticked
            // has to be able to say why, because the heuristic is wrong
            // sometimes and only the reader can tell.
            <Badge variant="outline" className="gap-1 border-border-strong">
              <ShieldAlert className="size-3" aria-hidden="true" />
              {t(`v3.jobs.wallet.spam.${row.spam}`)}
            </Badge>
          ) : null}
          {row.exited ? (
            // A `0` with nothing beside it reads as an empty position somebody
            // forgot to filter out. It is the opposite: a position that was
            // bought and sold, whose history has nowhere to land unless this
            // row is kept (SC-398).
            <Badge variant="outline" className="gap-1 border-border-strong">
              <History className="size-3" aria-hidden="true" />
              {t('v3.jobs.wallet.exited')}
            </Badge>
          ) : null}
        </label>
      }
      value={
        // No currency symbol: this is a count of tokens, and nothing here has
        // been priced yet. Formatted rather than the provider's raw string,
        // which v2 prints as-is.
        <Numeric value={row.balance} format="plain" decimals={quantityDecimals(row.balance)} />
      }
    />
  );
}

/**
 * The pre-review shape: holdings were created, and the review is pruning them.
 *
 * Kept because those job rows are still on people's lists. The rows link to the
 * holding rather than deleting in place *and* linking — deleting is here
 * because that is the only action this screen exists for.
 */
function WalletImportedHoldings({
  view,
  jobId,
  actionTakenAt,
}: {
  view: Extract<WalletImportView, { kind: 'imported' }>;
  jobId: string;
  actionTakenAt?: Date | string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { symbol: currency } = useBaseCurrency();
  const { deleteHolding, isDeleting } = useHoldingActions();
  const holdings = trpc.holdings.getWithDetails.useQuery(undefined, {
    enabled: view.holdingIds.length > 0,
  });
  const markActionTaken = trpc.jobs.markActionTaken.useMutation();

  const stamped = whenLabel(actionTakenAt);
  const byId = new Map(
    ((holdings.data?.holdings ?? []) as HoldingWithDetails[]).map((holding) => [
      holding.id,
      holding,
    ])
  );
  // Insertion order from the job result, not value order: sorting by value made
  // rows shuffle whenever a price refetch nudged one.
  const rows = view.holdingIds
    .map((id) => byId.get(id))
    .filter((h): h is HoldingWithDetails => !!h);

  const finish = async () => {
    try {
      await markActionTaken.mutateAsync({ jobId });
      await Promise.all([
        utils.jobs.getMine.invalidate({ jobId }),
        utils.jobs.listMine.invalidate(),
        utils.review.listPending.invalidate(),
      ]);
    } catch {
      // A stamp that did not land must not strand the reader on this screen.
    }
    await invalidatePortfolioQueries(utils, { refetchType: 'all' });
    navigate(V3_ROUTES.holdings);
  };

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <BlockHeader
          title={t(
            // "Imported holdings — 0 created" is a heading that contradicts
            // its own figures. A run that wrote nothing says so.
            view.holdingIds.length === 0 && view.holdingsCreated === 0
              ? 'v3.jobs.wallet.imported.nothingTitle'
              : 'v3.jobs.wallet.imported.title'
          )}
        />
        <DataRowList className="border-t border-border">
          <DataRow
            label={t('v3.jobs.wallet.imported.holdings')}
            value={<Numeric value={view.holdingsCreated} format="plain" decimals={0} />}
          />
          <DataRow
            label={t('v3.jobs.wallet.imported.accounts')}
            value={<Numeric value={view.accountsCreated} format="plain" decimals={0} />}
          />
          {view.chainNames.length > 0 ? (
            <DataRow
              label={t('v3.jobs.wallet.chainsDetected')}
              value={view.chainNames.join(', ')}
              wrapIdentity
            />
          ) : (
            <DataRow
              label={t('v3.jobs.wallet.chainsDetected')}
              value={<Numeric value={view.chainsDetected} format="plain" decimals={0} />}
            />
          )}
        </DataRowList>
        {view.holdingIds.length === 0 ? (
          <p className="border-t border-border p-4 text-body text-muted-foreground">
            {/* Only what the result records. Every branch of v2's version
                guessed at a cause and stated the guess as fact — "a provider
                API rejected the balance fetch" printed for a run in which none
                did (SC-145). */}
            {t(
              view.errors.length > 0
                ? 'v3.jobs.wallet.empty.unreadable'
                : view.chainsDetected === 0
                  ? 'v3.jobs.wallet.empty.noChains'
                  : 'v3.jobs.wallet.empty.zeroBalances'
            )}
          </p>
        ) : null}
      </Block>

      <ChainErrors lines={view.errors} />

      {view.holdingIds.length > 0 ? (
        <Block className="flex flex-col">
          <BlockHeader title={t('v3.jobs.wallet.imported.reviewTitle')} />
          {holdings.isLoading ? (
            <div className="border-t border-border p-4">
              <Skeleton className="h-24 w-full" aria-hidden="true" />
            </div>
          ) : rows.length === 0 ? (
            <p className="border-t border-border p-4 text-body text-muted-foreground">
              {t('v3.jobs.wallet.imported.allGone')}
            </p>
          ) : (
            <DataRowList className="border-t border-border">
              {rows.map((holding) => (
                <DataRow
                  key={holding.id}
                  label={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="font-medium">{holding.token.symbol}</span>
                      <span className="min-w-0 truncate text-muted-foreground">
                        {holding.token.name}
                      </span>
                      {isScamToken(holding.token.isScamProbability) ? (
                        <Badge variant="outline" className="gap-1 border-border-strong">
                          <ShieldAlert className="size-3" aria-hidden="true" />
                          {t('v3.tokens.hidden.likelyScam')}
                        </Badge>
                      ) : null}
                    </span>
                  }
                  sublabel={
                    <span className="flex items-center gap-1">
                      <Numeric
                        value={holding.amount}
                        format="plain"
                        decimals={quantityDecimals(holding.amount)}
                      />
                      <span>· {holding.account.name}</span>
                    </span>
                  }
                  value={<Numeric value={holding.value} currency={currency} />}
                  delta={
                    <span className="inline-flex items-center gap-2">
                      {holding.price ? (
                        <Numeric value={holding.price.value} currency={currency} />
                      ) : null}
                      {!stamped ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('v3.jobs.wallet.imported.remove', {
                            symbol: holding.token.symbol,
                          })}
                          disabled={isDeleting}
                          onClick={() => deleteHolding(holding.id)}
                        >
                          <Trash2 className="size-4 text-muted-foreground" aria-hidden="true" />
                        </Button>
                      ) : null}
                    </span>
                  }
                />
              ))}
            </DataRowList>
          )}

          <div className="flex flex-col gap-2 border-t border-border p-4">
            {stamped ? (
              <p className="text-caption text-muted-foreground">
                {t('v3.jobs.wallet.imported.finishedWhen', { when: stamped })}
              </p>
            ) : (
              <>
                <p className="text-caption text-muted-foreground">
                  {t('v3.jobs.wallet.imported.pruneNote')}
                </p>
                <Button
                  className="w-full"
                  disabled={markActionTaken.isPending}
                  onClick={() => {
                    void finish();
                  }}
                >
                  {markActionTaken.isPending ? (
                    <>
                      <Loader2 className="me-2 size-4 animate-spin" aria-hidden="true" />
                      {t('v3.jobs.wallet.imported.finishing')}
                    </>
                  ) : (
                    t('v3.jobs.wallet.imported.finish')
                  )}
                </Button>
              </>
            )}
            <Button asChild variant="outline" className="w-full lg:w-auto lg:self-start">
              <Link to={V3_ROUTES.holdings}>{t('v3.jobs.review.viewHoldings')}</Link>
            </Button>
          </div>
        </Block>
      ) : null}
    </div>
  );
}
