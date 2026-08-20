import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { groupRows } from '../../lib/home';
import { groupDetailPath } from '../../lib/routes';
import { DisclosureButton } from './DisclosureButton';

/**
 * Groups, with what each one is worth.
 *
 * v2's dashboard never showed groups at all — they were only reachable as an
 * allocation dimension and as their own page — but the user named them among
 * the things the home screen is missing, and a bucket of money the user defined
 * himself is exactly the kind of standing fact §2.1 says earns a block.
 *
 * The value comes from `groups.getValues`, not from the groups endpoint, which
 * counts members only. A "6 holdings" summary with no figure would be the
 * counts card this ticket exists to remove, renamed.
 *
 * It used to come from the allocation cut by group, joined to the counts here
 * on the client. SC-87 gave the group's own page and the groups list the same
 * figure, and three surfaces deriving one quantity three ways is exactly how
 * this app has contradicted itself before — so the aggregate moved to the API
 * and all three read it, the allocation cut included.
 *
 * A row opens the **group's own page**. When this block shipped there was no
 * such page, so it sent the reader to the holdings list filtered by the group —
 * the IA move `HoldingsPage` makes for institutions and accounts. SC-70 gave a
 * group a page precisely because it is more than a filter: its substance is an
 * editable member list, which is a screen's worth of interaction. So the row
 * that names a group now goes to the group, and the question "what is inside
 * this share" is answered by the allocation block's own rows, which do open the
 * filtered list (SC-74).
 */

/** Enough that a normal set of groups shows whole; the rest is one tap away. */
const GROUPS_SHOWN = 5;

export function GroupsBlock() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const groups = trpc.groups.getAllWithCounts.useQuery();
  const values = trpc.groups.getValues.useQuery();

  const currency = values.data?.baseCurrency ?? 'USD';
  const rows = groupRows(groups.data ?? [], values.data?.groups ?? [], t);

  // Nothing to summarise and nothing to offer: the user has not organised
  // anything into groups, and an empty block teaching him that groups exist is
  // an advert on the screen he checks his money on.
  if (groups.isLoading || rows.length === 0) return null;

  const shown = expanded ? rows : rows.slice(0, GROUPS_SHOWN);

  return (
    <Block>
      <BlockHeader title={t('v3.home.groups.title')} />
      <DataRowList className="border-t border-border">
        {shown.map((row) => (
          <DataRow
            key={row.id}
            leading={
              row.color ? (
                // The user's own colour for the group — identity he chose, not
                // a palette slot this screen assigned. Nothing is encoded by
                // it, so it owes no contrast floor beyond being visible.
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
              ) : null
            }
            label={row.name}
            sublabel={row.sublabel}
            value={<Numeric value={row.value} currency={currency} compact />}
            href={groupDetailPath(row.id)}
            aria-label={t('v3.home.groups.openGroup', { name: row.name })}
          />
        ))}
      </DataRowList>
      {rows.length > GROUPS_SHOWN ? (
        <div className="flex px-4 pt-2 pb-3">
          <DisclosureButton
            expanded={expanded}
            onToggle={() => setExpanded((open) => !open)}
            label={t('v3.home.disclosure.theOtherN', { count: rows.length - GROUPS_SHOWN })}
          />
        </div>
      ) : null}
    </Block>
  );
}
