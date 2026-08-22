import { formatDate, type HoldingWithDetails } from '@scani/shared';
import { FaviconImg } from '@scani/ui/components/FaviconImg';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { DeltaPill } from '@scani/ui/v3/components/charts/DeltaPill';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { PeekFact, PeekSection, PeekSpec } from '@scani/ui/v3/lib/peek';
import type { TFunction } from 'i18next';
import { Pencil, RefreshCw, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { institutionIconUrl } from '@/lib/icons';
import {
  amountDecimals,
  describeSource,
  hasCustomPrice,
  holdingGainLoss,
  holdingPrice,
  isSynced,
  payoutScheduleLabel,
  supportsApy,
} from '../../lib/holdings';
import { formatRelative } from '../../lib/relative-time';
import { groupDetailPath } from '../../lib/routes';
import { HoldingAmountFact } from './HoldingAmountFact';
import { HoldingDeleteAction } from './HoldingDeleteAction';
import { HoldingStatusAction } from './HoldingStatusAction';
import { HoldingTrend } from './HoldingTrend';
import { RealizedLedger } from './RealizedLedger';

/**
 * `HoldingDetailContent`, as a peek sheet.
 *
 * The port is a re-ranking rather than a re-skin. v2's page presents twenty-odd
 * fields as one flat run of `DetailRow`s with two charts in the middle and four
 * dialogs hanging off it; the sheet has a fixed header that survives every snap
 * point and a scrolling body, so the question is which four facts have to be
 * legible at the ~50% rest height. They are: how many units, at what price, in
 * which account, of what kind. Everything else — cost basis, P/L, status,
 * provenance, groups, interest — is a titled section reached by dragging up,
 * which is the same content one gesture further away rather than one screen.
 *
 * What is deliberately dropped: the two full recharts panels, replaced by the
 * sparkline in the header (see `HoldingTrend`). What is deliberately kept: every
 * action, including the ones v2 hid behind unlabelled 32px icon buttons in the
 * corner. They are labelled buttons here — an icon-only control with a `title`
 * is a desktop affordance, and this sheet's first surface is a phone.
 *
 * The dialogs are not opened from here. They are mounted by the page and reached
 * through these callbacks, because a Radix dialog opened from inside the drawer
 * would be unmounted the moment the drawer's own dismiss ran.
 */

export interface HoldingPeekContext {
  /** The user's base currency, as a symbol or ISO code. */
  currency: string;
  /** Carried on the context rather than passed to each builder below: the
   *  peek is assembled by six free functions, and threading `t` through all of
   *  them one parameter at a time is how one gets missed (SC-201). */
  t: TFunction;
  onSetAmount: (holding: HoldingWithDetails, balance: string) => void;
  onToggleActive: (holding: HoldingWithDetails) => void;
  /** True while an activate/deactivate write is in flight. */
  isTogglingActive?: boolean;
  onRefreshPrice: (holding: HoldingWithDetails) => void;
  onRefreshBalance: (holding: HoldingWithDetails) => void;
  /** The holding whose price / balance job is in flight, if any. */
  refreshingPriceId: string | null;
  refreshingBalanceId: string | null;
  onEditPrice: (holding: HoldingWithDetails) => void;
  onConfigureApy: (holding: HoldingWithDetails) => void;
  onRemoveApy: (holding: HoldingWithDetails) => void;
  /** The write itself. `HoldingDeleteAction` owns the confirmation, so by the
   *  time this runs the reader has read what goes and pressed a
   *  differently-labelled second button. */
  onDelete: (holding: HoldingWithDetails) => void;
  /** True while that delete is in flight. */
  isDeleting?: boolean;
}

function PriceFact({
  holding,
  currency,
  onEditPrice,
  t,
}: {
  holding: HoldingWithDetails;
  currency: string;
  onEditPrice: (holding: HoldingWithDetails) => void;
  t: TFunction;
}) {
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="flex items-center gap-2">
        <Numeric value={holdingPrice(holding)} currency={currency} />
        {hasCustomPrice(holding) ? (
          <button
            type="button"
            onClick={() => onEditPrice(holding)}
            aria-label={t('v3.holdings.peek.editPriceOf', { symbol: holding.token.symbol })}
            className="-my-1 rounded-md p-1 text-muted-foreground transition-colors duration-fast ease-emphasized hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </span>
      {holding.price?.timestamp ? (
        // Full-strength muted ink, not the `/70` v2 uses here: that composite
        // is one of the contrast failures §2.6 names, and a price's age is the
        // thing that decides whether to trust the figure above it.
        <span className="text-caption text-muted-foreground">
          {formatRelative(t, holding.price.timestamp)}
          {holding.price.source ? ` · ${holding.price.source}` : ''}
        </span>
      ) : null}
    </span>
  );
}

function apySection(holding: HoldingWithDetails, ctx: HoldingPeekContext): PeekSection {
  const config = holding.apyConfig;
  const { t } = ctx;

  if (!config) {
    return {
      title: t('v3.holdings.peek.interest'),
      facts: [
        {
          label: t('v3.holdings.peek.apy'),
          value: (
            <Button variant="outline" size="sm" onClick={() => ctx.onConfigureApy(holding)}>
              {t('v3.holdings.peek.configure')}
            </Button>
          ),
        },
      ],
    };
  }

  const facts: PeekFact[] = [
    {
      label: t('v3.holdings.peek.apy'),
      value: (
        <span className="flex items-center gap-2">
          <Numeric value={config.annualRatePct} format="percent" decimals={2} />
          <Button variant="ghost" size="sm" onClick={() => ctx.onConfigureApy(holding)}>
            {t('v3.holdings.peek.apyEdit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => ctx.onRemoveApy(holding)}
          >
            {t('v3.holdings.peek.apyRemove')}
          </Button>
        </span>
      ),
    },
    {
      label: t('v3.holdings.peek.payout'),
      value: payoutScheduleLabel(
        t,
        config.payoutFrequency,
        config.payoutDayOfWeek,
        config.payoutDayOfMonth,
        config.payoutMonth
      ),
    },
  ];

  if (config.lastPayoutAt) {
    facts.push({
      label: t('v3.holdings.peek.lastPayout'),
      value: formatRelative(t, config.lastPayoutAt),
    });
  }

  return { title: t('v3.holdings.peek.interest'), facts };
}

export function holdingPeekSpec(holding: HoldingWithDetails, ctx: HoldingPeekContext): PeekSpec {
  const { t } = ctx;
  const gainLoss = holdingGainLoss(holding);
  const priceBusy = ctx.refreshingPriceId === holding.id;
  const balanceBusy = ctx.refreshingBalanceId === holding.id;

  const record: PeekFact[] = [
    {
      label: t('v3.holdings.peek.status'),
      // A readout, not a control — see `HoldingStatusAction`, which is the
      // control and lives in the action row above. `outline` rather than the
      // filled `default`: a solid primary-purple pill in a column of plain
      // facts is the button this used to pretend to be.
      value: (
        <Badge variant={holding.isActive ? 'outline' : 'secondary'}>
          {holding.isActive ? t('v3.holdings.peek.active') : t('v3.holdings.peek.inactive')}
        </Badge>
      ),
    },
    { label: t('v3.holdings.peek.lastUpdated'), value: formatRelative(t, holding.lastUpdated) },
    {
      label: t('v3.holdings.peek.source'),
      value: holding.source ? describeSource(holding.source) : '—',
    },
    { label: t('v3.holdings.peek.added'), value: formatDate(holding.createdAt) },
  ];

  if (holding.unpriceable) {
    // The peek is where someone lands after seeing a dash in the list and
    // wanting to know why. The list badge is the flag; this is the sentence
    // (SC-154). Placed above `History` because it explains the value the
    // reader came here about, not a caveat on a chart.
    record.push({
      label: t('v3.holdings.peek.price'),
      value: t('v3.holdings.peek.unpriceableNote'),
    });
  }

  if (holding.dataIntegrity?.incompleteHistory) {
    // v2 hangs this on a `title` attribute on the table row, which a phone has
    // no way to show at all. It qualifies every historical figure for this
    // holding, so it belongs where those figures are read.
    record.push({
      label: t('v3.holdings.peek.history'),
      // The server's own note wins when it sends one — it knows which holding
      // this is. The fallback is ours and is the only half that translates.
      value: holding.dataIntegrity.note ?? t('v3.holdings.peek.incompleteHistory'),
    });
  }

  const sections: PeekSection[] = [];

  if (gainLoss) {
    sections.push({
      title: t('v3.holdings.peek.performance'),
      facts: [
        {
          label: t('v3.holdings.peek.costBasis'),
          value: <Numeric value={holding.costBasis} currency={ctx.currency} />,
        },
        {
          label: t('v3.holdings.peek.gainLoss'),
          value: (
            <Numeric
              value={gainLoss.percent}
              format="percent"
              decimals={1}
              delta
              indicator="sign"
            />
          ),
        },
      ],
    });
  }

  sections.push({ title: t('v3.holdings.peek.record'), facts: record });

  // Always shown, including when the answer is "none" (SC-70). "Which groups
  // is this in?" is a question a reader asks *of the holding*, and a section
  // that vanishes when the answer is nothing cannot be told apart from a
  // section that failed to load. Each badge routes to that group's page, which
  // is where membership is edited — the other direction of the same question,
  // and the reason the badges stopped being inert text.
  sections.push({
    title: t('v3.holdings.peek.groups'),
    facts: [
      {
        label: t('v3.holdings.peek.in'),
        value:
          holding.groups.length > 0 ? (
            <span className="flex flex-wrap justify-end gap-1.5">
              {holding.groups.map((group) => (
                <Link key={group.id} to={groupDetailPath(group.id)}>
                  <Badge
                    variant="outline"
                    className="transition-colors duration-fast hover:bg-surface-hover"
                    style={
                      group.color ? { borderColor: group.color, color: group.color } : undefined
                    }
                  >
                    {group.name}
                  </Badge>
                </Link>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('v3.holdings.peek.noGroups')}</span>
          ),
      },
    ],
  });

  if (supportsApy(holding)) sections.push(apySection(holding, ctx));

  return {
    title: holding.token.symbol,
    subtitle: `${holding.token.name} · ${holding.institution.name}`,
    leading: (
      <FaviconImg
        src={institutionIconUrl(holding.institution)}
        name={holding.institution.name}
        className="size-6 rounded-sm object-contain"
      />
    ),
    value: <Numeric value={holding.value} currency={ctx.currency} />,
    delta: gainLoss ? (
      <span className="flex flex-wrap items-center gap-2">
        <DeltaPill value={gainLoss.absolute} currency={ctx.currency} />
        {/* Muted rather than toned: the pill beside it already carries the
            direction in colour, and two coloured figures make the reader
            check whether they agree. It keeps its sign because muted ink
            cannot say which way it went. */}
        <Numeric
          value={gainLoss.percent}
          format="percent"
          decimals={1}
          delta
          indicator="sign"
          className="text-caption text-muted-foreground"
        />
      </span>
    ) : undefined,
    trend: (
      <HoldingTrend holdingId={holding.id} value={holding.value} symbol={holding.token.symbol} />
    ),
    // No `size="sm"` on any of these — for density, not for safety. SC-63
    // dropped it here on the grounds that `sm`'s `min-h-[36px]` beat the
    // `pointer: coarse` floor; SC-73 measured that and it is false. The floor
    // out-specifies the utility (0,3,1 against 0,1,0) and every `sm` control
    // inside `[data-ui='v3']` computes 44px on touch — the 36px SC-63 saw was
    // a desktop-pointer reading at a phone *width*, which is the size `sm` is
    // supposed to be. The reason to stay at the default size is that this row
    // wraps to two lines beside `ConfirmAction`'s open block, which has no
    // `sm`, and one row of two heights reads as a mistake. See
    // `tests/v3/token-hygiene.test.ts` for the guard that pins the floor.
    actions: (
      <>
        <Button variant="outline" onClick={() => ctx.onRefreshPrice(holding)} disabled={priceBusy}>
          {/* Disabled plus a changed label rather than a spinning icon: the
              motion policy (V3-16) has not landed, and an unguarded
              `animate-spin` is exactly the thing §2.4 says every animation
              must be kept out of until it is. */}
          <RefreshCw className="mr-2 size-4" aria-hidden="true" />
          {priceBusy ? t('v3.holdings.peek.refreshing') : t('v3.holdings.peek.refreshPrice')}
        </Button>
        {isSynced(holding) ? (
          <Button
            variant="outline"
            onClick={() => ctx.onRefreshBalance(holding)}
            disabled={balanceBusy}
          >
            <Wallet className="mr-2 size-4" aria-hidden="true" />
            {balanceBusy ? t('v3.holdings.peek.syncing') : t('v3.holdings.peek.syncBalance')}
          </Button>
        ) : null}
        <HoldingStatusAction
          holding={holding}
          currency={ctx.currency}
          onToggle={ctx.onToggleActive}
          isPending={ctx.isTogglingActive}
        />
        <HoldingDeleteAction
          holding={holding}
          currency={ctx.currency}
          onDelete={ctx.onDelete}
          isPending={ctx.isDeleting}
        />
      </>
    ),
    primary: [
      {
        label: t('v3.holdings.peek.amount'),
        value: (
          <HoldingAmountFact
            amount={holding.amount}
            onSave={(balance) => ctx.onSetAmount(holding, balance)}
          />
        ),
      },
      {
        label: t('v3.holdings.peek.price'),
        value: (
          <PriceFact
            holding={holding}
            currency={ctx.currency}
            onEditPrice={ctx.onEditPrice}
            t={t}
          />
        ),
      },
      { label: t('v3.holdings.peek.account'), value: holding.account.name },
      // Only on the holdings that carry one, which is the small set where an
      // account holds several rows for one token (SC-330). A "Pot: —" row on
      // every other holding would be a field that says nothing.
      ...(holding.label ? [{ label: t('v3.holdings.peek.pot'), value: holding.label }] : []),
      { label: t('v3.holdings.peek.type'), value: holding.token.type || holding.token.typeCode },
    ],
    // The `content` slot rather than a section, because a ledger of disposals
    // each with its own lots under it is not a run of label/value pairs — the
    // same reason the transfer-review chooser is here (SC-150). It renders
    // itself away on the holdings that never disposed of anything, which is
    // most of them, so `content` is empty in the ordinary case.
    content: (
      <RealizedLedger
        holdingId={holding.id}
        currency={ctx.currency}
        symbol={holding.token.symbol}
      />
    ),
    sections,
  };
}

/** The row's third zone: P/L when there is a cost basis to measure against,
 *  and nothing when there is not. Exported because the list and the desktop
 *  table's last column are the same claim and must not drift. */
export function holdingRowDelta(holding: HoldingWithDetails) {
  const gainLoss = holdingGainLoss(holding);
  if (!gainLoss) return undefined;
  return <Numeric value={gainLoss.percent} format="percent" decimals={1} delta indicator="sign" />;
}

/** The unit count, at the precision the number actually carries. */
export function holdingAmount(holding: HoldingWithDetails, className?: string) {
  return (
    <Numeric
      value={holding.amount}
      format="plain"
      decimals={amountDecimals(holding.amount)}
      className={className}
    />
  );
}
