import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { ArrowLeft, Globe, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getFaviconUrl } from '@/lib/icons';
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

  const institutions = trpc.institutions.getAll.useQuery();
  const types = trpc.institutionTypes.getAll.useQuery();

  const items = institutions.data ?? [];
  const term = query.trim().toLowerCase();
  const options = (term ? items.filter((i) => i.name.toLowerCase().includes(term)) : items)
    .slice(0, 20)
    .map((institution) => {
      const favicon = getFaviconUrl(institution.website);
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
    });

  const selectedLabel = items.find((institution) => institution.id === value)?.name ?? value;

  /**
   * Fills the name from the site's OpenGraph metadata. Silent on failure by
   * design — the name field is right there, and an error toast for "we could
   * not guess it for you" is noise about something the user was going to do
   * anyway.
   */
  const fetchSiteName = async () => {
    const url = normalizeWebsite(draft.website);
    if (!url || fetchingSite) return;
    setFetchingSite(true);
    try {
      const meta = await utils.institutions.getOpenGraphMetadata.fetch({ url });
      const name = meta.siteName || meta.title;
      if (name) onDraftChange({ name });
    } catch {
      // Handled above.
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
        className="-ml-2 self-start"
        disabled={disabled}
        onClick={() => {
          onDraftChange({ name: '', typeId: '', website: '' });
          onModeChange('existing');
        }}
      >
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
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
            onBlur={() => void fetchSiteName()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void fetchSiteName();
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
            onClick={() => void fetchSiteName()}
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
          <SelectTrigger className="text-body" aria-label={t('v3.capture.institution.typeLabel')}>
            <SelectValue placeholder={t('v3.capture.institution.typePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {(types.data ?? []).map((type) => (
              <SelectItem key={type.id} value={type.id} className="text-body">
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
