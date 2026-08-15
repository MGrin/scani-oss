import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import {
  type AccountTargetDraft,
  emptyAccountTarget,
  type NewAccountDraft,
  type NewInstitutionDraft,
} from '../lib/manual-entry';

/**
 * "Where does this land" — the institution/account pair two capture forms ask
 * for, including the `?accountId=` / `?institutionId=` context the sheet
 * forwards.
 *
 * Both the state and the two selection rules live here rather than in either
 * page, because the rules are the interesting part and duplicating them is how
 * they go out of sync:
 *
 * - **Changing the institution clears the account under it.** Keeping it would
 *   submit an account that belongs somewhere else entirely.
 * - **Picking an account fills in the institution it belongs to**, when that
 *   field was left empty. Someone who knows the account name but not which of
 *   two brokers holds it should not have to answer the harder question first.
 *
 * The prefill waits for both lists: an `accountId` names its institution only
 * through the account record, and an `institutionId` from a URL is only
 * trustworthy once it is known to exist. It runs exactly once — a later change
 * is the user's own and must not be overwritten by a query settling.
 */
export interface AccountTarget {
  draft: AccountTargetDraft;
  patch: (next: Partial<AccountTargetDraft>) => void;
  patchInstitution: (next: Partial<NewInstitutionDraft>) => void;
  patchAccount: (next: Partial<NewAccountDraft>) => void;
  selectInstitution: (institutionId: string) => void;
  selectAccount: (accountId: string, institutionId: string | null) => void;
}

export function useAccountTarget(): AccountTarget {
  const [searchParams] = useSearchParams();
  const urlAccountId = searchParams.get('accountId') ?? '';
  const urlInstitutionId = searchParams.get('institutionId') ?? '';

  const accounts = trpc.accounts.getAll.useQuery();
  const institutions = trpc.institutions.getAll.useQuery();

  const [draft, setDraft] = useState<AccountTargetDraft>(() => ({
    ...emptyAccountTarget(),
    accountId: urlAccountId,
  }));
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (prefilled || !accounts.data || !institutions.data) return;
    const fromAccount = urlAccountId
      ? accounts.data.find((account) => account.id === urlAccountId)?.institutionId
      : undefined;
    const fromUrl =
      urlInstitutionId &&
      institutions.data.some((institution) => institution.id === urlInstitutionId)
        ? urlInstitutionId
        : undefined;
    const institutionId = fromAccount ?? fromUrl;
    if (institutionId) setDraft((current) => ({ ...current, institutionId }));
    setPrefilled(true);
  }, [prefilled, accounts.data, institutions.data, urlAccountId, urlInstitutionId]);

  const patch = (next: Partial<AccountTargetDraft>) =>
    setDraft((current) => ({ ...current, ...next }));

  return {
    draft,
    patch,
    patchInstitution: (next) =>
      setDraft((current) => ({
        ...current,
        newInstitution: { ...current.newInstitution, ...next },
      })),
    patchAccount: (next) =>
      setDraft((current) => ({ ...current, newAccount: { ...current.newAccount, ...next } })),
    selectInstitution: (institutionId) =>
      patch({ institutionId, accountId: '', accountMode: 'existing' }),
    selectAccount: (accountId, institutionId) =>
      setDraft((current) => ({
        ...current,
        accountId,
        institutionId:
          !current.institutionId && current.institutionMode === 'existing' && institutionId
            ? institutionId
            : current.institutionId,
      })),
  };
}
