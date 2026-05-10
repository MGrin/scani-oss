import { TRPCClientError } from '@trpc/client';
import { ArrowRight, CheckCircle2, Clock } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { trpc } from '../../lib/trpc';

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'joined' }
  | { kind: 'already-joined' }
  | { kind: 'error'; message: string };

export function BetaPromise() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (status.kind === 'submitting') return;
    setStatus({ kind: 'submitting' });
    try {
      const res = await trpc.waitlist.join.mutate({
        email: email.trim().toLowerCase(),
        source: 'landing',
        referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
      });
      // The router returns `{ ok, alreadyJoined }`; mirror it back as
      // distinct UI states so the success copy is honest about whether
      // we just persisted a new row or rediscovered an existing one.
      const r = res as { ok: boolean; alreadyJoined: boolean };
      setStatus({ kind: r.alreadyJoined ? 'already-joined' : 'joined' });
    } catch (err) {
      const message =
        err instanceof TRPCClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Something went wrong';
      setStatus({ kind: 'error', message });
    }
  };

  return (
    <section
      id="beta"
      className="border-b border-border/60 bg-gradient-to-b from-background to-card/40 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-3xl px-6 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
          <Clock className="h-3 w-3" />
          Beta preview
        </div>
        <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Join now. Lock in 1 year of paid tiers, free.
        </h2>
        <p className="mt-4 text-balance text-muted-foreground">
          Subscriptions aren't live yet. Anyone who creates an account on{' '}
          <a className="underline-offset-4 hover:underline" href="https://app.scani.xyz">
            app.scani.xyz
          </a>{' '}
          or{' '}
          <a className="underline-offset-4 hover:underline" href="https://cloud.scani.xyz">
            cloud.scani.xyz
          </a>{' '}
          — or drops their email below — gets the equivalent of every paid plan free for the first
          12 months once we flip on billing.
        </p>

        <form
          onSubmit={submit}
          className="mx-auto mt-10 flex max-w-md flex-col gap-3 sm:flex-row"
          aria-label="Beta-preview waitlist signup"
        >
          <input
            type="email"
            required
            placeholder="you@work.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status.kind === 'submitting' || status.kind === 'joined'}
            className="h-11 flex-1 rounded-md border border-border bg-background px-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={status.kind === 'submitting' || status.kind === 'joined'}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {status.kind === 'submitting' ? 'Joining…' : 'Join the waitlist'}
            {status.kind !== 'submitting' && <ArrowRight className="h-4 w-4" />}
          </button>
        </form>

        <div aria-live="polite" className="mt-4 min-h-[20px] text-sm">
          {status.kind === 'joined' && (
            <p className="inline-flex items-center gap-1.5 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              You're on the list. We'll email when subscriptions launch.
            </p>
          )}
          {status.kind === 'already-joined' && (
            <p className="inline-flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle2 className="h-4 w-4" />
              Already on the list — your beta perk is locked in.
            </p>
          )}
          {status.kind === 'error' && <p className="text-destructive">{status.message}</p>}
        </div>

        <p className="mt-6 text-xs text-muted-foreground">
          We'll only use this address to tell you when billing turns on and to honor your
          beta-preview discount. No marketing list, no resale.
        </p>
      </div>
    </section>
  );
}
