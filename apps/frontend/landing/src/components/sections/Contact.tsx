import { ANALYTICS_EVENTS, capture, identifyUser } from '@scani/analytics/client';
import { TRPCClientError } from '@trpc/client';
import { ArrowRight, CheckCircle2, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';
import { trpc } from '../../lib/trpc';

const SUPPORT_EMAIL = 'support@scani.xyz';

const TOPICS = [
  { value: 'support', label: 'Support — help with my account' },
  { value: 'sales', label: 'Sales — pricing, plans & tiers' },
  { value: 'feedback', label: 'Feedback — ideas, requests & bugs' },
  { value: 'security', label: 'Security — report a vulnerability' },
  { value: 'other', label: 'Something else' },
] as const;

type Topic = (typeof TOPICS)[number]['value'];

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

export function Contact() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [topic, setTopic] = useState<Topic>('support');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const ref = useRevealOnScroll<HTMLElement>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (status.kind === 'submitting') return;
    setStatus({ kind: 'submitting' });
    const normalizedEmail = email.trim().toLowerCase();
    try {
      await trpc.contact.submit.mutate({
        name: name.trim(),
        email: normalizedEmail,
        topic,
        message: message.trim(),
        referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
      });
      setStatus({ kind: 'sent' });
      identifyUser({ id: normalizedEmail, email: normalizedEmail });
      capture(ANALYTICS_EVENTS.contactSubmitted, { topic });
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

  const disabled = status.kind === 'submitting' || status.kind === 'sent';
  const fieldClass =
    'rounded-md border border-border bg-background px-4 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 sm:text-sm';

  return (
    <section
      ref={ref}
      id="contact"
      data-reveal="section"
      className="bg-gradient-to-b from-background to-card/40 px-6 pb-20 pt-24 sm:pb-28 sm:pt-32"
    >
      <div className="mx-auto max-w-xl">
        <div className="text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Get in touch
          </h1>
          <p className="mt-4 text-balance text-muted-foreground">
            Questions about a plan, a stuck integration, an idea, or a security report — send it our
            way and a human replies, usually within one business day.
          </p>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="mt-4 inline-flex items-center gap-1.5 text-sm text-foreground/80 underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            <Mail className="h-4 w-4" />
            {SUPPORT_EMAIL}
          </a>
        </div>

        {status.kind === 'sent' ? (
          <div className="mt-10 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-6 py-8 text-center">
            <p className="inline-flex items-center gap-2 font-medium text-emerald-400">
              <CheckCircle2 className="h-5 w-5" />
              Message sent.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Thanks for reaching out. We've emailed a receipt to{' '}
              <span className="text-foreground">{email}</span> and the team will reply there
              shortly.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-10 flex flex-col gap-4" aria-label="Contact form">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="contact-name" className="text-sm font-medium">
                Name
              </label>
              <input
                id="contact-name"
                type="text"
                required
                maxLength={120}
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={disabled}
                className={`h-12 ${fieldClass}`}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="contact-email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="contact-email"
                type="email"
                required
                maxLength={254}
                inputMode="email"
                autoComplete="email"
                placeholder="you@work.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={disabled}
                className={`h-12 ${fieldClass}`}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="contact-topic" className="text-sm font-medium">
                What's this about?
              </label>
              <select
                id="contact-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value as Topic)}
                disabled={disabled}
                className={`h-12 ${fieldClass}`}
              >
                {TOPICS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="contact-message" className="text-sm font-medium">
                Message
              </label>
              <textarea
                id="contact-message"
                required
                minLength={10}
                maxLength={4000}
                rows={6}
                placeholder="Tell us what you need. The more detail, the faster we can help."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={disabled}
                className={`min-h-[140px] resize-y py-3 ${fieldClass}`}
              />
            </div>

            <button
              type="submit"
              disabled={disabled}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {status.kind === 'submitting' ? 'Sending…' : 'Send message'}
              {status.kind !== 'submitting' && <ArrowRight className="h-4 w-4" />}
            </button>

            <div aria-live="polite" className="min-h-[20px] text-sm">
              {status.kind === 'error' && <p className="text-destructive">{status.message}</p>}
            </div>
          </form>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          We only use your address to reply to this message. No marketing list, no resale.
        </p>
      </div>
    </section>
  );
}
