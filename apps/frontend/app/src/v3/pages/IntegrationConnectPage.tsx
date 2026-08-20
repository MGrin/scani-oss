import { safeExternalUrl } from '@scani/shared';
import { Input } from '@scani/ui/ui/input';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Textarea } from '@scani/ui/ui/textarea';
import { Block } from '@scani/ui/v3/components/Block';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { CaptureSubmit } from '../components/capture/CaptureSubmit';
import type { Integration } from '../components/capture/IntegrationsList';
import { InstitutionMark } from '../components/entities/InstitutionMark';
import { Field, FieldSet } from '../components/form/Field';
import {
  buildCredentials,
  type CaptureStage,
  describeCredentialBlockers,
} from '../lib/capture-forms';
import { connectErrorCopy } from '../lib/connect-error';
import { jobDetailPath, V3_CAPTURE_ROUTES, V3_ROUTES } from '../lib/routes';

/**
 * One service's credentials.
 *
 * A page, not v2's dialog. The manifest decides how many fields there are and
 * what kind — IBKR's is a multi-line token, Kraken's is a key and a secret —
 * and a Radix dialog on a 390px phone renders all of that inside a box the
 * software keyboard covers and which has no scroll of its own. A page also
 * survives the back gesture with what has been typed, which a dialog dismissed
 * by the same gesture does not.
 *
 * The setup steps stay above the fields rather than below them, because that is
 * the order the task happens in: nobody has an API key before they read how to
 * make one. v2 renders them above too and then hides them the moment the form is
 * busy — which is when someone re-reading step 3 most needs them.
 */
export function IntegrationConnectPage() {
  const { t } = useTranslation();
  const { providerKey = '' } = useParams<{ providerKey: string }>();
  const integrationsQuery = trpc.integrations.listAvailable.useQuery();
  const loadingPhase = useDelayedLoading(integrationsQuery.isLoading);

  const integration = (integrationsQuery.data ?? []).find(
    (candidate) => candidate.providerKey === providerKey
  );

  if (integrationsQuery.isError) {
    return (
      <PageLayout>
        <CaptureHeader
          title={t('v3.capture.integration.title')}
          description={t('v3.capture.integration.subtitle')}
          backTo={V3_CAPTURE_ROUTES.integrations}
          backLabel={t('v3.capture.integration.allServices')}
        />
        <QueryError
          error={integrationsQuery.error}
          subject={t('v3.capture.integration.thisService')}
          onRetry={() => void integrationsQuery.refetch()}
        />
      </PageLayout>
    );
  }

  if (integrationsQuery.isLoading) {
    return (
      <PageLayout>
        <CaptureHeader
          title={t('v3.capture.integration.title')}
          description={t('v3.capture.integration.subtitle')}
          backTo={V3_CAPTURE_ROUTES.integrations}
          backLabel={t('v3.capture.integration.allServices')}
        />
        <LoadingRamp
          phase={loadingPhase}
          label={t('v3.capture.integration.thisService')}
          skeleton={
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          }
        />
      </PageLayout>
    );
  }

  if (!integration) {
    return (
      <PageLayout>
        <CaptureHeader
          title={t('v3.capture.integration.notFoundTitle')}
          description={t('v3.capture.integration.notFoundBody')}
          backTo={V3_CAPTURE_ROUTES.integrations}
          backLabel={t('v3.capture.integration.allServices')}
        />
      </PageLayout>
    );
  }

  // Keyed on the provider so moving between two services never carries one
  // service's half-typed secret into the other's form.
  return <ConnectForm key={integration.providerKey} integration={integration} />;
}

function ConnectForm({ integration }: { integration: Integration }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [values, setValues] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<CaptureStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validateKeys = trpc.integrations.validateKeys.useMutation();

  const { credentialFields, instructions, providerKey, institution } = integration;
  const docsUrl = safeExternalUrl(instructions.docsUrl);

  const submit = async () => {
    if (stage) return;
    setError(null);
    setStage('connect');
    try {
      const result = await validateKeys.mutateAsync({
        providerKey,
        credentials: buildCredentials(credentialFields, values),
        requestId: crypto.randomUUID(),
      });
      // A manifest with `skipServerValidation` enqueues nothing to watch, so
      // there is no job page to land on — the holdings are where the result
      // will appear either way.
      navigate(result.jobId ? jobDetailPath(result.jobId) : V3_ROUTES.holdings);
    } catch (err) {
      // `connect`, not the default `load`: the reader pressed "Connect Kraken"
      // and was told "Couldn't load Kraken. The server returned an error",
      // which names neither the action they took nor the field that was wrong
      // (SC-140). The keys are validated upstream before anything is stored, so
      // the provider's own reason is both available and the only useful thing
      // to say — as long as there IS a reason, which `connectErrorText` is what
      // decides (SC-445).
      const copy = connectErrorCopy(t, err, institution.name);
      setError(`${copy.title}. ${copy.detail}`);
      setStage(null);
    }
  };

  const busy = stage !== null;

  return (
    <PageLayout>
      <CaptureHeader
        title={t('v3.capture.integration.connectNamed', { name: institution.name })}
        description={t('v3.capture.integration.permissions')}
        backTo={V3_CAPTURE_ROUTES.integrations}
        backLabel={t('v3.capture.integration.allServices')}
      />

      {instructions.steps.length > 0 ? (
        <Block>
          <FieldSet title={t('v3.capture.integration.whereToGet')}>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-body text-muted-foreground marker:text-caption">
              {instructions.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {docsUrl ? (
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 self-start rounded-md text-label text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('v3.capture.integration.ownDocs', { name: institution.name })}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
            {/* Rendered at every width rather than behind a user-agent sniff.
                v2 shows this only when `navigator.userAgent` looks like a phone,
                which silently hides it on an iPad and on any desktop browser
                whose user is about to follow these steps on their phone
                anyway. */}
            {instructions.mobileNote ? (
              <p className="rounded-md border border-border-strong bg-surface-hover p-3 text-caption">
                {instructions.mobileNote}
              </p>
            ) : null}
          </FieldSet>
        </Block>
      ) : null}

      <Block>
        <FieldSet title={t('v3.capture.integration.credentials')}>
          <div className="flex items-center gap-2 pb-1">
            <InstitutionMark name={institution.name} website={institution.website} size="size-5" />
            <span className="text-label">{institution.name}</span>
          </div>

          {credentialFields.map((field) => {
            const id = `credential-${field.name}`;
            const value = values[field.name] ?? '';
            const onChange = (next: string) =>
              setValues((current) => ({ ...current, [field.name]: next }));

            return (
              <Field
                key={field.name}
                label={
                  field.required
                    ? field.label
                    : t('v3.capture.form.optionalField', { label: field.label })
                }
                htmlFor={id}
                hint={field.hint}
              >
                {field.type === 'textarea' ? (
                  <Textarea
                    id={id}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    placeholder={
                      field.placeholder ?? t('v3.capture.form.pasteField', { label: field.label })
                    }
                    rows={4}
                    className="font-mono text-body"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy}
                  />
                ) : (
                  <Input
                    id={id}
                    type={field.sensitive ? 'password' : 'text'}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    placeholder={
                      field.placeholder ?? t('v3.capture.form.pasteField', { label: field.label })
                    }
                    className="font-mono text-body"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy}
                  />
                )}
              </Field>
            );
          })}
        </FieldSet>
      </Block>

      <CaptureSubmit
        label={t('v3.capture.integration.connectNamed', { name: institution.name })}
        blockers={describeCredentialBlockers(credentialFields, values, t)}
        onSubmit={submit}
        stage={stage}
        busyLabel="the connection"
        error={error}
      />
    </PageLayout>
  );
}
