import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { type VaultRow, vaultRows } from '../../lib/home';
import { vaultDetailPath } from '../../lib/routes';
import { DisclosureButton } from './DisclosureButton';

/**
 * Savings goals and how close each one is — v2's `VaultProgressList`, on v3
 * primitives.
 *
 * Not a `<DataRow>`: a vault's answer is a *ratio*, and the row's three zones
 * have nowhere to put a track. So it keeps the row's grid and hairlines and
 * adds the one thing it needs, which is the reason `<DataRow>` refuses a
 * fourth zone rather than growing one.
 *
 * The track is the vault's own colour over `--muted`, which is the same
 * treatment as v2's and for the same reason as the group swatch: the colour is
 * the user's identity for the vault, not an encoding this screen chose. The
 * percentage is stated in text beside it, so nothing depends on reading a
 * length.
 *
 * Each row is a **link to the vault's page** (SC-74). It shipped as three
 * nested `<span>`s inside a `<div>` — nothing on it was a control, so the one
 * screen the app opens on displayed the reader's savings goals and offered no
 * way to reach any of them. That went unnoticed by a QA pass for the reason it
 * was reported by a person instead: unlike the Upcoming rows SC-69 fixed, these
 * never *looked* tappable, so nothing about them read as broken until someone
 * tried to open one.
 */

/** Three fit above the fold under everything else on a phone. */
const VAULTS_SHOWN = 3;

/**
 * One vault, as a link.
 *
 * No `min-h-tap`: the 44px floor on touch comes from the token layer matching
 * `a[href]` under `pointer: coarse` (V3-23), which the utility class would only
 * duplicate on touch and impose on a mouse. Three stacked lines clear it at
 * every pointer type anyway; the rule is what guarantees it.
 */
export function VaultProgressRow({ row }: { row: VaultRow }) {
  const { t } = useTranslation();

  return (
    <li>
      <Link
        to={vaultDetailPath(row.id)}
        className={cn(
          'flex flex-col gap-2 px-4 py-3',
          'transition-colors duration-fast ease-emphasized',
          // `--surface-hover`, not `--surface-2`: the latter is white on the
          // V3-23 light page, so a hover fill built on it would not show.
          'hover:bg-surface-hover active:bg-surface-hover',
          // Inset, like `DataRow`'s: a full-bleed row has no margin for an
          // offset ring, which its neighbours would clip.
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
        )}
      >
        <span className="flex items-center gap-3">
          {row.color ? (
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: row.color }}
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-label">{row.name}</span>
          <Numeric
            value={row.progress}
            format="percent"
            decimals={0}
            className="text-label whitespace-nowrap"
          />
        </span>
        <span
          className="block h-1.5 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={t('v3.home.vaults.progress', {
            name: row.name,
            percent: Math.round(row.progress),
          })}
        >
          <span
            className="block h-full rounded-full"
            style={{
              width: `${row.fill}%`,
              backgroundColor: row.color ?? 'hsl(var(--interactive))',
            }}
          />
        </span>
        <span className="flex items-baseline justify-between gap-3 text-caption text-muted-foreground">
          <Numeric value={row.current} currency={row.currency} compact />
          <span>
            <Trans
              i18nKey="v3.home.vaults.ofTarget"
              components={{
                target: <Numeric value={row.target} currency={row.currency} compact />,
              }}
            />
          </span>
        </span>
      </Link>
    </li>
  );
}

export function VaultsBlock() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const vaults = trpc.vaults.getAll.useQuery();

  const rows = vaultRows(vaults.data ?? []);
  if (vaults.isLoading || rows.length === 0) return null;

  const shown = expanded ? rows : rows.slice(0, VAULTS_SHOWN);

  return (
    <Block>
      <BlockHeader title={t('v3.home.vaults.title')} />
      <ul className="divide-y divide-border border-t border-border">
        {shown.map((row) => (
          <VaultProgressRow key={row.id} row={row} />
        ))}
      </ul>
      {rows.length > VAULTS_SHOWN ? (
        <div className="flex px-4 pt-2 pb-3">
          <DisclosureButton
            expanded={expanded}
            onToggle={() => setExpanded((open) => !open)}
            label={t('v3.home.disclosure.theOtherN', { count: rows.length - VAULTS_SHOWN })}
          />
        </div>
      ) : null}
    </Block>
  );
}
