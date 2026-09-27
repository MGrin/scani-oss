import { cn } from '@scani/ui/lib/cn';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { ArrowLeft, Globe, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { institutionIconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import type { NewInstitutionDraft, PickMode } from '../../lib/manual-entry';
import { normalizeWebsite } from '../../lib/manual-entry';
import { Field } from '../form/Field';
import { RecordPicker } from '../form/RecordPicker';

/**
 * Where the account is held — an existing institution, or one being created.
 *
 * Two states, one field. v2 renders the same thing as a picker that swaps
 * itself for a three-input sub-form inside a `Card`, which is right; what is
 * wrong there is that the sub-form's inputs are 14px, its labels 12px and its
 * way back a `←  Select existing` string used as a button label.
 *
 * `institutions.getAll` rather than the user's own institutions: the catalogue
 * is system-wide, and a new user filtered down to what they already have would
 * see an empty picker and conclude the field is broken.
 */

interface InstitutionFieldProps {
  mode: PickMode;
  /** The chosen institution, when `mode` is `existing`. */
  value: string;
  draft: NewInstitutionDraft;
  onModeChange: (mode: PickMode) => void;
  onSelect: (institutionId: string) => void;
  onDraftChange: (patch: Partial<NewInstitutionDraft>) => void;
  disabled?: boolean;
}

export function InstitutionField({
  mode,
  value,
  draft,
  onModeChange,
  onSelect,
  onDraftChange,
  disabled,
}: InstitutionFieldProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [fetchingSite, setFetchingSite] = useState(false);
  const utils = trpc.useUtils();
  const createFromWebsite = trpc.institutions.createFromWebsite.useMutation();

  const institutions = trpc.institutions.getAll.useQuery();
  const types = trpc.institutionTypes.getAll.useQuery();

  const items = institutions.data ?? [];
  const term = query.trim().toLowerCase();
  // `RecordPicker` caps and announces it (SC-862) — see `AccountField`, which
  // sits directly below this one in the same fieldset.
  const options = (term ? items.filter((i) => i.name.toLowerCase().includes(term)) : items).map(
    (institution) => {
      const favicon = institutionIconUrl(institution);
      return {
        id: institution.id,
        label: institution.name,
        leading: favicon ? (
          <img
            src={favicon}
            alt=""
            className="h-4 w-4 shrink-0 rounded-sm object-contain"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : undefined,
      };
    }
  );

  const selectedLabel = items.find((institution) => institution.id === value)?.name ?? value;

  /**
   * Adds the institution from its website (SC-1354): the server scrapes the
   * site and returns the shared catalogue row for it, creating that row if this
   * is the first time anyone has added the site. The field then shows it as
   * picked. Silent when the site gives no name: the name field is right there,
   * and a hand-typed institution stays private to this user.
   */
  const addFromWebsite = async () => {
    const url = normalizeWebsite(draft.website);
    if (!url || fetchingSite) return;
    setFetchingSite(true);
    try {
      const found = await createFromWebsite.mutateAsync({
        url,
        ...(draft.typeId ? { typeId: draft.typeId } : {}),
      });
      if (found) {
        await utils.institutions.getAll.invalidate();
        onDraftChange({ name: '', typeId: '', website: '' });
        onSelect(found.id);
        onModeChange('existing');
      }
    } catch {
      // Not a public site, or the scrape failed: the user types the name.
    }
    setFetchingSite(false);
  };

  if (mode === 'existing') {
    return (
      <Field label={t('v3.capture.institution.label')} htmlFor="manual-institution">
        <RecordPicker
          inputId="manual-institution"
          ariaLabel="institution"
          value={value ? { id: value, label: selectedLabel } : null}
          onSelect={(id) => {
            onSelect(id);
            setQuery('');
          }}
          onClear={() => {
            onSelect('');
            setQuery('');
            setOpen(true);
          }}
          query={query}
          onQueryChange={setQuery}
          open={open}
          onOpenChange={setOpen}
          options={options}
          isLoading={institutions.isLoading}
          placeholder={t('v3.capture.institution.searchPlaceholder')}
          emptyLabel={t('v3.capture.institution.noResults')}
          createLabel={(text) =>
            text
              ? t('v3.capture.institution.addNamed', { name: text })
              : t('v3.capture.institution.addUnlisted')
          }
          onCreate={(text) => {
            onDraftChange({ name: text });
            onModeChange('new');
            setQuery('');
            setOpen(false);
          }}
          disabled={disabled}
        />
      </Field>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="ghost"
        className="-ms-2 self-start"
        disabled={disabled}
        onClick={() => {
          onDraftChange({ name: '', typeId: '', website: '' });
          onModeChange('existing');
        }}
      >
        <ArrowLeft className={cn(MIRROR_IN_RTL, 'me-1 h-4 w-4')} aria-hidden="true" />
        {t('v3.capture.institution.pickExisting')}
      </Button>

      <Field
        label={t('v3.capture.institution.website')}
        htmlFor="manual-institution-website"
        hint={t('v3.capture.institution.websiteHint')}
      >
        <div className="flex gap-2">
          <Input
            id="manual-institution-website"
            value={draft.website}
            onChange={(event) => onDraftChange({ website: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void addFromWebsite();
            }}
            placeholder="revolut.com"
            className="min-w-0 flex-1 text-body"
            disabled={disabled}
          />
          <Button
            variant="outline"
            size="icon"
            className="shrink-0"
            aria-label={t('v3.capture.institution.lookUpName')}
            onClick={() => void addFromWebsite()}
            disabled={fetchingSite || !draft.website.trim() || disabled}
          >
            {fetchingSite ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Globe className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </Field>

      <Field label={t('v3.capture.institution.name')} htmlFor="manual-institution-name">
        <Input
          id="manual-institution-name"
          value={draft.name}
          onChange={(event) => onDraftChange({ name: event.target.value })}
          placeholder={t('v3.capture.institution.namePlaceholder')}
          className="text-body"
          disabled={disabled}
        />
      </Field>

      <Field label={t('v3.capture.institution.type')}>
        <Select
          value={draft.typeId}
          onValueChange={(typeId) => onDraftChange({ typeId })}
          disabled={disabled}
        >
          <SelectTrigger aria-label={t('v3.capture.institution.typeLabel')}>
            <SelectValue placeholder={t('v3.capture.institution.typePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {(types.data ?? []).map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
