import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { Field } from '../components/form/Field';
import { type OwnershipBucket, OwnershipTotals } from '../components/ownership/OwnershipTotals';
import { UNASSIGNED_ENTITY } from '../lib/ownership';

/**
 * Ownership boundaries — one owner, two sets of books (SC-463).
 *
 * A contractor with a limited company keeps their own money and the company's
 * apart, and files separately; net worth is still one number to the person who
 * owns both. So this screen shows the parts and the whole together, and the
 * account assignment that produces them.
 *
 * **The boundary is set on ACCOUNTS, and this page only ever assigns
 * accounts.** `holdings.account_id` is NOT NULL, so an account carrying one
 * `entity_id` partitions its holdings for free — no holding can be in two
 * boundaries or in none. Offering a per-holding assignment would reintroduce
 * exactly the overlap that made groups unusable for this (SC-463's research:
 * `GroupValuationService` counts a holding fully in every group claiming it,
 * and has a named test requiring that).
 *
 * **Not tax output.** SC-90 is parked
 * (`docs/technical/2026-08-14_why-no-tax-statement.md`) and this does not
 * reopen it. Nothing on this page may acquire a tax framing.
 */
export function EntitiesPage() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const entitiesQuery = trpc.entities.getAll.useQuery();
  const valuesQuery = trpc.entities.getValues.useQuery();
  const accountsQuery = trpc.accounts.getByUserIdWithSummary.useQuery();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const invalidate = () => {
    void utils.entities.getAll.invalidate();
    void utils.entities.getValues.invalidate();
    void utils.accounts.getByUserIdWithSummary.invalidate();
  };

  const createEntity = trpc.entities.create.useMutation({
    onSuccess: (entity) => {
      setCreating(false);
      setName('');
      showSuccess(t('v3.ownership.created', { name: entity.name }));
    },
    onError: (error) => showError(error, t('v3.ownership.creating')),
    onSettled: invalidate,
  });

  const assignAccounts = trpc.entities.assignAccounts.useMutation({
    onError: (error) => showError(error, t('v3.ownership.assigning')),
    onSettled: invalidate,
  });

  const state = mergeQueries(entitiesQuery, valuesQuery);
  const entities = entitiesQuery.data ?? [];
  const values = valuesQuery.data;
  const accounts = accountsQuery.data ?? [];

  const nameById = new Map(entities.map((entity) => [entity.id, entity.name]));

  // Every bucket the server returned, named. The unassigned one is appended
  // rather than filtered out when empty — see `OwnershipTotals` for why.
  const buckets: OwnershipBucket[] = values
    ? [
        ...values.entities.map((bucket) => ({
          ...bucket,
          name: nameById.get(bucket.entityId) ?? bucket.entityId,
        })),
        { ...values.unassigned, name: t('v3.ownership.unassigned') },
      ]
    : [];

  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.ownership.title')}
        action={
          <Button onClick={() => setCreating(true)} disabled={creating}>
            <Plus className="me-1.5 size-4" aria-hidden="true" />
            {t('v3.ownership.newEntity')}
          </Button>
        }
      />

      <p className="text-caption text-muted-foreground">{t('v3.ownership.description')}</p>

      {creating ? (
        <Block className="flex flex-col gap-3 p-4">
          <Field label={t('v3.ownership.name')} htmlFor="new-entity-name">
            <Input
              id="new-entity-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('v3.ownership.namePlaceholder')}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              onClick={() => createEntity.mutate({ name: name.trim() })}
              disabled={name.trim().length === 0 || createEntity.isPending}
            >
              {t('v3.ownership.create')}
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t('v3.ownership.cancel')}
            </Button>
          </div>
        </Block>
      ) : null}

      {values ? (
        <OwnershipTotals
          buckets={buckets}
          totalValue={values.totalValue}
          baseCurrency={values.baseCurrency}
        />
      ) : (
        <Block className="p-4 text-caption text-muted-foreground">
          {state.isLoading ? t('v3.ownership.loading') : t('v3.ownership.empty')}
        </Block>
      )}

      {/*
        Assignment lives on this page rather than behind a per-entity detail
        screen because the question a reader has here is "which side is each
        account on", which is one list, not one list per boundary.
      */}
      <Block className="flex flex-col p-4" data-testid="ownership-assignment">
        <h2 className="mb-2 text-label font-medium">{t('v3.ownership.accountsHeading')}</h2>
        <ul className="flex flex-col divide-y divide-border">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between gap-4 py-2.5"
              data-testid={`ownership-account-${account.id}`}
            >
              <span className="min-w-0 flex-1 truncate text-label">{account.name}</span>
              {/*
                The shared `Select`, not a native `<select>` — and the reason is
                the hit area rather than the styling (SC-978).

                Nothing gives a `<select>` the 44px touch floor. V3-23's
                `@media (pointer: coarse)` block in `v3-tokens.css` spends
                `--tap-target` on `button, [role=button], [role=tab],
                [role=radiogroup], a[href], input[type=button|submit]`, and the
                unscoped v2 rule it neutralises
                (`apps/frontend/app/src/styles/accessibility.css`) lists the
                same shapes. `select` is in neither, so `h-9` was the whole
                answer: a 36px target on a phone.

                And the gate could not see it. `measureUndersizedTargets`
                (`apps/e2e/fixtures/a11y.ts`) walks `button, a[href],
                [role="button"], [role="tab"], summary`, so the one v3 control
                that was not a `<button>` was the one control the §2.6 walk
                never measured. Both facts have the same cause, and a
                `SelectTrigger` fixes both at once: it is a `<button>`, so the
                token layer hands it 44px on touch and the walk starts counting
                it. `token-hygiene.test.ts` keeps the raw element from coming
                back.

                Weighed against keeping the native picker, which is a real
                option and is what `DateField` chose: that decision was about a
                native input rendering its *value* in the system locale, which a
                `<select>` does not do — it shows the option text we give it. So
                the defect that justifies keeping the platform control there
                does not exist here, and what is left is one control behaving
                unlike the five other v3 selects.

                Sizes: the trigger stays `text-caption`, subordinate to the
                account name it sits beside — the identity is the column that
                should not give way. The open list is `text-body`, matching
                every other v3 dropdown. Width is capped so a long entity name
                clamps inside the trigger instead of pushing the account name
                out at 390px.
              */}
              <Select
                value={account.entityId ?? UNASSIGNED_ENTITY}
                disabled={assignAccounts.isPending}
                onValueChange={(next) =>
                  assignAccounts.mutate({
                    accountIds: [account.id],
                    entityId: next === UNASSIGNED_ENTITY ? null : next,
                  })
                }
              >
                <SelectTrigger
                  aria-label={t('v3.ownership.accountEntityLabel', { name: account.name })}
                  data-testid={`ownership-account-select-${account.id}`}
                  className="w-auto max-w-[50%] shrink-0 gap-2 text-caption"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED_ENTITY} className="text-body">
                    {t('v3.ownership.unassigned')}
                  </SelectItem>
                  {entities.map((entity) => (
                    <SelectItem key={entity.id} value={entity.id} className="text-body">
                      {entity.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          ))}
        </ul>
      </Block>
    </PageLayout>
  );
}
