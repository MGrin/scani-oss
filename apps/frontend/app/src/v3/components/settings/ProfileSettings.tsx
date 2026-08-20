import { AUTO_REGION, formatDate, formatNumber, supportedFormatRegions } from '@scani/shared';
import { Input } from '@scani/ui/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { showError } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormatLocale } from '@/contexts/FormatLocaleContext';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { AVAILABLE_LANGUAGES } from '@/i18n';
import { trpc } from '@/lib/trpc';
import { optimisticPatchUser } from '@/v3/hooks/optimisticUpdates';
import { FiatCurrencyField } from '../form/FiatCurrencyField';
import { Field, FieldRow, FieldSet } from '../form/Field';

/**
 * Who you are and how figures are shown to you — the two blocks at the top of
 * Settings.
 *
 * They are two blocks rather than one because they answer different questions
 * and only one of them writes to the account: name and email identify a person,
 * base currency and language change what every other screen renders. Language
 * in particular does not go through the mutation at all — it is an i18next
 * call that takes effect immediately and is remembered client-side — and
 * grouping it with the fields that *do* auto-save would make the save notice
 * below them a claim about a control it does not cover.
 *
 * The auto-save is v2's, unchanged in behaviour: one second after the last
 * keystroke, optimistically patched, and a base-currency change refetches every
 * query that renders money. Reproducing it rather than reusing it is not an
 * option — it lives inline in `SettingsPage.tsx` and v2 is not this rebuild's
 * to refactor — so what is reused is the two helpers it is built out of.
 */

const AUTOSAVE_DELAY_MS = 1000;

/**
 * The date the Region field renders as its own preview.
 *
 * A day past the 12th and a month with a short name, so the three things a
 * region changes are all visible at once: order, separator and month form.
 * `7/5/2026` would be the one date that shows nothing, which is also why
 * SC-175 was filed.
 */
const SAMPLE_DATE = new Date(Date.UTC(2026, 6, 16));
const SAMPLE_NUMBER = 1234.5;

export function ProfileSettings() {
  const { t, i18n } = useTranslation();
  const { locale, region, setRegion } = useFormatLocale();
  const utils = trpc.useUtils();
  const userQuery = trpc.users.getCurrent.useQuery();
  const user = userQuery.data;

  const [name, setName] = useState('');
  const [baseCurrencyId, setBaseCurrencyId] = useState('');

  const update = trpc.users.updateCurrent.useMutation({
    onMutate: async (variables) => {
      // The pre-patch value has to be captured before the optimistic write,
      // or the currency-change check below is fooled by our own patch.
      const previousBaseCurrencyId = utils.users.getCurrent.getData()?.baseCurrencyId ?? null;
      const snapshot = await optimisticPatchUser(utils, {
        name: variables.name,
        baseCurrencyId: variables.baseCurrencyId,
      });
      return { snapshot, previousBaseCurrencyId };
    },
    onSuccess: (_data, variables, context) => {
      // Both fields are always submitted, so a real currency change is only
      // detectable against the captured previous value — otherwise fixing a
      // typo in your name refetches every chart in the app.
      const next = variables.baseCurrencyId ?? null;
      if (next !== (context?.previousBaseCurrencyId ?? null)) {
        void invalidatePortfolioQueries(utils, { refetchType: 'all' });
      }
    },
    onError: (error, _variables, context) => {
      context?.snapshot.restore();
      showError(error, t('v3.settings.pending.savingSettings'));
    },
    onSettled: () => {
      void utils.users.getCurrent.invalidate();
      void utils.users.getBaseCurrency.invalidate();
    },
  });

  useEffect(() => {
    if (!user) return;
    setName(user.name || '');
    setBaseCurrencyId(user.baseCurrencyId || '');
  }, [user]);

  /**
   * Region names from `Intl`, in whatever language the interface is in.
   *
   * Not from the string catalogue: 12 region names in 9 languages is 108
   * entries for something every runtime already knows, and it is the same
   * argument `weekdayName` and `monthName` settled in `@scani/shared`. Sorted
   * in the interface language too — alphabetical is not the same order twice.
   *
   * `supportedFormatRegions` rather than the candidate list, because THIS
   * browser decides: Chromium has no `en-BR` and answers with plain `en`, so
   * offering Brazil there is offering a control that does nothing. A region
   * already stored is kept in the list regardless — a preference set on a
   * browser that honours it must not vanish from the control on one that does
   * not, which would read as the app forgetting it.
   */
  const regions = useMemo(() => {
    const names = new Intl.DisplayNames([locale.language], { type: 'region' });
    const codes = new Set(supportedFormatRegions(locale.language));
    if (region !== AUTO_REGION) codes.add(region);
    return [...codes]
      .map((code) => ({ code, name: names.of(code) ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name, locale.language));
  }, [locale.language, region]);

  const isDirty = Boolean(
    user && (name !== (user.name || '') || baseCurrencyId !== (user.baseCurrencyId || ''))
  );

  const { mutate } = update;
  useEffect(() => {
    if (!isDirty) return;
    const timer = setTimeout(
      () => mutate({ name: name || undefined, baseCurrencyId: baseCurrencyId || undefined }),
      AUTOSAVE_DELAY_MS
    );
    return () => clearTimeout(timer);
  }, [name, baseCurrencyId, isDirty, mutate]);

  return (
    <>
      <Block>
        <FieldSet title={t('settings.profile')}>
          <FieldRow>
            <Field label={t('settings.name')} htmlFor="settings-name">
              <Input
                id="settings-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('settings.namePlaceholder')}
                className="text-body"
              />
            </Field>
            {/* Not a disabled `<Input>`. Beside the editable Name it was the
                same box, the same height and the same border, and the only
                thing separating "you may type here" from "you may not" was
                the cursor — which a phone does not have (SC-69 2.3). A fact
                the app is showing you is drawn as a fact: no field chrome, the
                sentence under it says why, and there is nothing to tap. */}
            <Field label={t('settings.email')} hint={t('v3.settings.profile.emailImmutable')}>
              <p className="min-w-0 truncate py-2.5 text-body">{user?.email ?? ''}</p>
            </Field>
          </FieldRow>
        </FieldSet>
      </Block>

      <Block>
        <FieldSet title={t('settings.preferences')}>
          <FieldRow>
            <Field
              label={t('settings.baseCurrency')}
              htmlFor="settings-currency"
              hint={t('v3.settings.profile.baseCurrencyHint')}
            >
              <FiatCurrencyField
                id="settings-currency"
                value={baseCurrencyId}
                onChange={setBaseCurrencyId}
              />
            </Field>

            <Field
              label={t('settings.language')}
              htmlFor="settings-language"
              hint={t('settings.languageHint')}
            >
              <Select
                value={i18n.resolvedLanguage ?? i18n.language}
                onValueChange={(code) => void i18n.changeLanguage(code)}
              >
                <SelectTrigger id="settings-language" className="text-body">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AVAILABLE_LANGUAGES.map((language) => (
                    <SelectItem key={language.code} value={language.code}>
                      {language.nativeName}
                      {language.nativeName === language.name ? '' : ` — ${language.name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>

          <FieldRow>
            <Field
              label={t('settings.region')}
              htmlFor="settings-region"
              // The preview is the point of the hint. A reader cannot be asked
              // to know what `en-DE` does to a date; showing them one is the
              // only way the setting explains itself, and it is also what makes
              // this verifiable in a browser with no translator involved.
              hint={t('settings.regionHint', {
                sample: `${formatDate(SAMPLE_DATE)} · ${formatNumber(SAMPLE_NUMBER, { decimals: 2 })}`,
              })}
            >
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger id="settings-region" className="text-body">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_REGION}>{t('settings.regionAuto')}</SelectItem>
                  {regions.map((entry) => (
                    <SelectItem key={entry.code} value={entry.code}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
        </FieldSet>
      </Block>

      {/* `aria-live`, because this is the only feedback either block gives: a
          form with no Save button has to say out loud that it saved, and a
          screen reader user gets no visual cue at all. */}
      <p aria-live="polite" className="text-caption text-muted-foreground">
        {update.isPending ? t('settings.saving') : isDirty ? t('settings.autoSave') : ''}
      </p>
    </>
  );
}
