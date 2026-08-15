import { Button } from '@scani/ui/ui/button';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { CreateCustomTokenDialog } from '@/v2/components/tokens/CreateCustomTokenDialog';
import { EditCustomTokenPriceDialog } from '@/v2/components/tokens/EditCustomTokenPriceDialog';
import { type CustomTokenRow, CustomTokensList } from '../components/tokens/CustomTokensList';
import { HiddenHoldingsList } from '../components/tokens/HiddenHoldingsList';
import {
  type HiddenHoldingRow,
  resolveTokenSegment,
  TOKEN_SEGMENTS,
  type TokenSegment,
  tokenSegmentPath,
} from '../lib/tokens';

/**
 * The two kinds of asset the automatic pipeline does not handle for you:
 * manually-priced custom tokens, and holdings kept off the dashboard.
 *
 * v2 stacks them as two sections of one scrolling page. Two stacked lists means
 * two search boxes and two empty states on one screen, and on a phone the
 * second one is below everything the first one has. The segmented control gives
 * each its own list and its own URL at the cost of one control — the same trade
 * the Money tab makes, and for the same reason.
 *
 * Both queries run on either segment: they are small, and react-query dedupes,
 * so moving between the two is instant rather than a fresh skeleton each time.
 */
export function TokensPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const segment = resolveTokenSegment(pathname);

  const customQuery = trpc.tokens.listCustom.useQuery();
  const hiddenQuery = trpc.holdings.getHidden.useQuery();

  const [creating, setCreating] = useState(false);
  const [pricing, setPricing] = useState<CustomTokenRow | null>(null);

  return (
    <PageLayout measure="wide">
      <PageHeader
        title="Tokens"
        action={
          segment === 'custom' ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 size-4" aria-hidden="true" />
              New custom token
            </Button>
          ) : undefined
        }
      />

      <Segmented
        value={segment}
        onValueChange={(next) => navigate(tokenSegmentPath(next as TokenSegment))}
        aria-label="Tokens view"
      >
        {TOKEN_SEGMENTS.map((entry) => (
          <SegmentedItem key={entry.key} value={entry.key}>
            {entry.label}
          </SegmentedItem>
        ))}
      </Segmented>

      {segment === 'custom' ? (
        <CustomTokensList
          tokens={(customQuery.data ?? []) as CustomTokenRow[]}
          query={mergeQueries(customQuery)}
          onCreate={() => setCreating(true)}
          onEditPrice={setPricing}
        />
      ) : (
        <HiddenHoldingsList
          holdings={(hiddenQuery.data ?? []) as HiddenHoldingRow[]}
          query={mergeQueries(hiddenQuery)}
        />
      )}

      <CreateCustomTokenDialog open={creating} onOpenChange={setCreating} />

      {/* Mounted only while targeted, so the price form starts from the token it
          was opened for rather than from the last one. */}
      {pricing ? (
        <EditCustomTokenPriceDialog
          open
          onOpenChange={(open) => {
            if (!open) setPricing(null);
          }}
          tokenId={pricing.id}
          tokenSymbol={pricing.symbol}
          currentPrice={pricing.latestPrice}
          currentBaseCurrency={pricing.latestPriceBaseCurrency}
        />
      ) : null}
    </PageLayout>
  );
}
