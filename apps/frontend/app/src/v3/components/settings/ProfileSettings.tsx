import { Input } from '@scani/ui/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { showError } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_LANGUAGES } from '@/i18n';
import { trpc } from '@/lib/trpc';
import { FiatCurrencySelect } from '@/v2/components/shared/FiatCurrencySelect';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import { optimisticPatchUser } from '@/v2/hooks/optimisticUpdates';
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

export function ProfileSettings() {
  const { t, i18n } = useTranslation();
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
      showError(error, 'Saving your settings');
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
            <Field
              label={t('settings.email')}
              hint="Changing this is not something the app can do yet."
            >
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
              hint="Every figure in the app is converted into this."
            >
              <FiatCurrencySelect
                id="settings-currency"
                value={baseCurrencyId}
                onChange={setBaseCurrencyId}
                triggerClassName="text-body"
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
