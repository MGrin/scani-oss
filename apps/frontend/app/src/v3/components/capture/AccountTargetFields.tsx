import type { AccountTarget } from '../../hooks/useAccountTarget';
import { FieldSet } from '../form/Field';
import { AccountField } from './AccountField';
import { InstitutionField } from './InstitutionField';

/**
 * The "where" section every capture form that creates holdings opens with.
 *
 * A hairline between the two fields, because either can expand into a
 * three-input sub-form and then the pair reads as one long list of fields with
 * no boundary — which is the one thing v2's two Cards did get right. A rule is
 * the cheaper half of that (§5.3: a run of rows of the same shape separates by a
 * hairline and nothing else).
 */
export function AccountTargetFields({
  target,
  disabled,
  title = 'Where',
}: {
  target: AccountTarget;
  disabled?: boolean;
  /** Overridden by the file import, where the section answers a different
   *  question than it does on a form the user is typing figures into. */
  title?: string;
}) {
  const { draft } = target;

  return (
    <FieldSet title={title}>
      <div className="flex flex-col divide-y divide-border">
        <div className="pb-3">
          <InstitutionField
            mode={draft.institutionMode}
            value={draft.institutionId}
            draft={draft.newInstitution}
            onModeChange={(institutionMode) => target.patch({ institutionMode })}
            onSelect={target.selectInstitution}
            onDraftChange={target.patchInstitution}
            disabled={disabled}
          />
        </div>

        <div className="pt-3">
          <AccountField
            mode={draft.accountMode}
            value={draft.accountId}
            draft={draft.newAccount}
            institutionId={draft.institutionId}
            institutionIsNew={draft.institutionMode === 'new'}
            onModeChange={(accountMode) => target.patch({ accountMode })}
            onSelect={target.selectAccount}
            onDraftChange={target.patchAccount}
            disabled={disabled}
          />
        </div>
      </div>
    </FieldSet>
  );
}
