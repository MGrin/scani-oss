import { safeExternalUrl } from '@scani/shared';
import { Input } from '@scani/ui/ui/input';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Textarea } from '@scani/ui/ui/textarea';
import { Block } from '@scani/ui/v3/components/Block';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
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
          title="Connect a service"
          description="One set of read-only keys, encrypted at rest."
          backTo={V3_CAPTURE_ROUTES.integrations}
          backLabel="All services"
        />
        <QueryError
          error={integrationsQuery.error}
          subject="this service"
          onRetry={() => void integrationsQuery.refetch()}
        />
      </PageLayout>
    );
  }

  if (integrationsQuery.isLoading) {
    return (
      <PageLayout>
        <CaptureHeader
          title="Connect a service"
          description="One set of read-only keys, encrypted at rest."
          backTo={V3_CAPTURE_ROUTES.integrations}
          backLabel="All services"
        />
        <LoadingRamp
          phase={loadingPhase}
          label="this service"
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
          title="Not one of ours"
          description="Scani has no integration by that name. It may have been renamed, or the link may be out of date."
          backTo={V3_CAPTURE_ROUTES.integrations}
          backLabel="All services"
        />
      </PageLayout>
    );
  }

  // Keyed on the provider so moving between two services never carries one
  // service's half-typed secret into the other's form.
  return <ConnectForm key={integration.providerKey} integration={integration} />;
}

function ConnectForm({ integration }: { integration: Integration }) {
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
      // to say.
      const copy = describeQueryError(err, institution.name, 'connect');
      setError(`${copy.title}. ${copy.detail}`);
      setStage(null);
    }
  };

  const busy = stage !== null;

  return (
    <PageLayout>
      <CaptureHeader
        title={`Connect ${institution.name}`}
        description="Read-only permissions are all Scani needs. Keys are encrypted at rest and never leave our workers."
        backTo={V3_CAPTURE_ROUTES.integrations}
        backLabel="All services"
      />

      {instructions.steps.length > 0 ? (
        <Block>
          <FieldSet title="Where to get them">
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
                {institution.name}'s own documentation
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
        <FieldSet title="Credentials">
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
                label={field.required ? field.label : `${field.label} (optional)`}
                htmlFor={id}
                hint={field.hint}
              >
                {field.type === 'textarea' ? (
                  <Textarea
                    id={id}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    placeholder={field.placeholder ?? `Paste your ${field.label}`}
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
                    placeholder={field.placeholder ?? `Paste your ${field.label}`}
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
        label={`Connect ${institution.name}`}
        blockers={describeCredentialBlockers(credentialFields, values)}
        onSubmit={submit}
        stage={stage}
        busyLabel="the connection"
        error={error}
      />
    </PageLayout>
  );
}
