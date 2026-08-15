import { Input } from '@scani/ui/ui/input';
import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { CaptureSubmit } from '../components/capture/CaptureSubmit';
import { Field, FieldSet } from '../components/form/Field';
import {
  buildWalletImportInput,
  type CaptureStage,
  describeWalletAddressProblem,
  describeWalletImportBlockers,
  emptyWalletImportDraft,
} from '../lib/capture-forms';
import { jobDetailPath } from '../lib/routes';

/**
 * A wallet address, watched rather than connected — no key ever leaves the
 * device, because there is no key.
 *
 * The shortest form in the capture set, and the one where v2's grey button was
 * least defensible: the only thing it can ever be waiting for is the address,
 * and it would not say so. The address field is `font-mono` for the reason every
 * address field is — a proportional face renders `0` and `O`, `1` and `l`
 * indistinguishably, and this is a value people check character by character
 * after pasting it.
 *
 * The address is checked against the chains Scani actually reads, at the field
 * (SC-67). Before that, anything twelve characters long was accepted and became
 * a queued job that failed minutes later on `/jobs` — a correction the user had
 * to go and find, for a mistake one keystroke would have fixed here.
 */
export function WalletImportPage() {
  const navigate = useNavigate();

  const [draft, setDraft] = useState(emptyWalletImportDraft);
  const [stage, setStage] = useState<CaptureStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addressLeft, setAddressLeft] = useState(false);

  const addressProblem = describeWalletAddressProblem(draft.address);
  // Said once the field has been left, and — for anything already long enough
  // to be a finished paste — while it still has focus. Neither on its own is
  // enough: a wrong paste should not have to wait for a blur to be named, and
  // the first three characters of a correct one should not be called wrong.
  const showAddressProblem =
    addressProblem !== null && (addressLeft || draft.address.trim().length >= 12);

  const importAddress = trpc.wallet.importAddress.useMutation({
    onSuccess: ({ jobId }) => navigate(jobDetailPath(jobId)),
    onError: (err) => {
      const copy = describeQueryError(err, 'this wallet');
      setError(`${copy.title}. ${copy.detail}`);
      setStage(null);
    },
  });

  const submit = () => {
    const input = buildWalletImportInput(draft, crypto.randomUUID());
    if (!input || stage) return;
    setError(null);
    setStage('enqueue');
    importAddress.mutate(input);
  };

  const busy = stage !== null;

  return (
    <PageLayout>
      <CaptureHeader
        title="Watch a wallet address"
        description="We detect which chain it is on, read its balances off the chain, and refresh them every hour."
      />

      <Block>
        <FieldSet title="The address">
          <Field
            label="Wallet address"
            htmlFor="wallet-address"
            hint={
              showAddressProblem ? (
                <span id="wallet-address-problem" className="text-destructive">
                  {addressProblem}
                </span>
              ) : (
                'Any supported chain — Ethereum, Bitcoin, Solana and the rest. You do not have to say which.'
              )
            }
          >
            <Input
              id="wallet-address"
              value={draft.address}
              onChange={(event) =>
                setDraft((current) => ({ ...current, address: event.target.value }))
              }
              onBlur={() => setAddressLeft(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setAddressLeft(true);
                  submit();
                }
              }}
              placeholder="0x… or bc1… or …"
              className="font-mono text-body"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={showAddressProblem || undefined}
              aria-describedby={showAddressProblem ? 'wallet-address-problem' : undefined}
              disabled={busy}
            />
          </Field>

          <Field
            label="Name"
            htmlFor="wallet-name"
            hint="Optional. What you call this wallet, rather than its address."
          >
            <Input
              id="wallet-name"
              value={draft.displayName}
              onChange={(event) =>
                setDraft((current) => ({ ...current, displayName: event.target.value }))
              }
              placeholder="Cold storage, Trading wallet…"
              className="text-body"
              disabled={busy}
            />
          </Field>
        </FieldSet>
      </Block>

      <CaptureSubmit
        label="Watch this wallet"
        blockers={describeWalletImportBlockers(draft)}
        onSubmit={submit}
        stage={stage}
        busyLabel="the import"
        error={error}
      />
    </PageLayout>
  );
}
