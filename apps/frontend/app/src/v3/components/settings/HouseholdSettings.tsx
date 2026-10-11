import { formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Switch } from '@scani/ui/ui/switch';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { FiatCurrencyField } from '../form/FiatCurrencyField';

/**
 * A household (SC-1647): read-only access to the accounts each member chooses
 * to share. Nothing here edits another member's records. `mine` refetches
 * every minute, so a member removed elsewhere loses the view on that read
 * rather than on a push the server cannot send.
 */
export function HouseholdSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const mine = trpc.household.mine.useQuery(undefined, { refetchInterval: 60_000 });
  const refresh = () => void utils.household.mine.invalidate();

  if (mine.error) {
    return (
      <Block className="p-4">
        <QueryError
          error={mine.error}
          subject={t('v3.settings.household.subject')}
          onRetry={() => void mine.refetch()}
        />
      </Block>
    );
  }
  if (!mine.data) {
    return (
      <Block className="p-4">
        <Skeleton className="h-10 w-full" aria-hidden="true" />
      </Block>
    );
  }

  const { household, members, invites, sharedAccountIds } = mine.data;
  return (
    <Block className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.household.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.household.intro')}</p>
      </div>
      {household ? (
        <>
          <Members members={members} isAdmin={household.role === 'admin'} onChanged={refresh} />
          {household.role === 'admin' ? (
            <>
              <InviteForm onInvited={refresh} />
              <PendingInvites invites={invites} onChanged={refresh} />
              <HouseholdCurrency value={household.baseCurrencyId} onChanged={refresh} />
            </>
          ) : null}
          <SharedAccounts sharedAccountIds={sharedAccountIds} onChanged={refresh} />
          <Leave name={household.name} onLeft={refresh} />
        </>
      ) : (
        <CreateForm onCreated={refresh} />
      )}
    </Block>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const create = trpc.household.create.useMutation({
    onSuccess: () => {
      setName('');
      onCreated();
    },
    onError: (error) => showError(error, t('v3.settings.household.creating')),
  });
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) create.mutate({ name: name.trim() });
      }}
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('v3.settings.household.namePlaceholder')}
        aria-label={t('v3.settings.household.nameLabel')}
        maxLength={60}
      />
      <Button type="submit" disabled={!name.trim() || create.isPending}>
        {t('v3.settings.household.create')}
      </Button>
    </form>
  );
}

type Member = { userId: string; name: string; role: 'admin' | 'member'; joinedAt: string | Date };

function Members({
  members,
  isAdmin,
  onChanged,
}: {
  members: Member[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-muted-foreground">{t('v3.settings.household.members')}</h3>
      <ul className="flex flex-col divide-y divide-border">
        {members.map((member) => (
          <MemberRow key={member.userId} member={member} isAdmin={isAdmin} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({
  member,
  isAdmin,
  onChanged,
}: {
  member: Member;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  const [handing, setHanding] = useState(false);
  const remove = trpc.household.remove.useMutation({
    onSuccess: () => {
      setRemoving(false);
      onChanged();
    },
    onError: (error) => showError(error, t('v3.settings.household.removing')),
  });
  const hand = trpc.household.transferAdmin.useMutation({
    onSuccess: () => {
      setHanding(false);
      onChanged();
    },
    onError: (error) => showError(error, t('v3.settings.household.handingOver')),
  });
  const other = member.role !== 'admin';
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="flex flex-col">
        <span className="text-body">{member.name}</span>
        <span className="text-caption text-muted-foreground">
          {member.role === 'admin'
            ? t('v3.settings.household.roleAdmin')
            : t('v3.settings.household.roleMember')}
        </span>
      </div>
      {isAdmin && other ? (
        <div className="flex gap-1">
          <ConfirmAction
            label={t('v3.settings.household.makeAdmin')}
            confirmLabel={t('v3.settings.household.makeAdminConfirm', { name: member.name })}
            consequence={t('v3.settings.household.makeAdminConsequence')}
            open={handing}
            onOpenChange={setHanding}
            isPending={hand.isPending}
            onConfirm={() => hand.mutate({ userId: member.userId })}
          />
          <ConfirmAction
            label={t('v3.settings.household.remove')}
            triggerClassName="text-destructive hover:text-destructive"
            destructive
            confirmLabel={t('v3.settings.household.removeConfirm', { name: member.name })}
            consequence={t('v3.settings.household.removeConsequence')}
            open={removing}
            onOpenChange={setRemoving}
            isPending={remove.isPending}
            onConfirm={() => remove.mutate({ userId: member.userId })}
          />
        </div>
      ) : null}
    </li>
  );
}

function InviteForm({ onInvited }: { onInvited: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ url: string; emailed: boolean; to: string } | null>(null);
  const invite = trpc.household.invite.useMutation({
    onSuccess: (result, variables) => {
      setSent({ ...result, to: variables.email });
      setEmail('');
      onInvited();
    },
    onError: (error) => showError(error, t('v3.settings.household.inviting')),
  });
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-muted-foreground">{t('v3.settings.household.invite')}</h3>
      <form
        data-household="invite"
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (email.trim()) invite.mutate({ email: email.trim() });
        }}
      >
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t('v3.settings.household.emailPlaceholder')}
          aria-label={t('v3.settings.household.emailLabel')}
          maxLength={254}
        />
        <Button type="submit" disabled={!email.trim() || invite.isPending}>
          {t('v3.settings.household.sendInvite')}
        </Button>
      </form>
      {sent ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <p className="text-body">
            {sent.emailed
              ? t('v3.settings.household.emailed', { email: sent.to })
              : t('v3.settings.household.notEmailed')}
          </p>
          <code className="break-all text-caption">{sent.url}</code>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(sent.url)
                  .then(() => showSuccess(t('v3.settings.household.copied')))
              }
            >
              {t('v3.settings.household.copyLink')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSent(null)}>
              {t('v3.settings.household.done')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PendingInvites({
  invites,
  onChanged,
}: {
  invites: Array<{ id: string; email: string; expiresAt: string | Date }>;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const revoke = trpc.household.revoke.useMutation({
    onSuccess: onChanged,
    onError: (error) => showError(error, t('v3.settings.household.revoking')),
  });
  if (invites.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-muted-foreground">{t('v3.settings.household.pending')}</h3>
      <ul className="flex flex-col divide-y divide-border">
        {invites.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="flex flex-col">
              <span className="text-body">{invite.email}</span>
              <span className="text-caption text-muted-foreground">
                {t('v3.settings.household.expires', { date: formatDate(invite.expiresAt) })}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate({ inviteId: invite.id })}
            >
              {t('v3.settings.household.revoke')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SharedAccounts({
  sharedAccountIds,
  onChanged,
}: {
  sharedAccountIds: string[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const accounts = trpc.accounts.getByUserIdWithSummary.useQuery();
  const onError = (error: unknown) => showError(error, t('v3.settings.household.sharing'));
  const share = trpc.household.share.useMutation({ onSuccess: onChanged, onError });
  const unshare = trpc.household.unshare.useMutation({ onSuccess: onChanged, onError });
  const shared = new Set(sharedAccountIds);
  const busy = share.isPending || unshare.isPending;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-muted-foreground">
        {t('v3.settings.household.yourAccounts')}
      </h3>
      <p className="text-caption text-muted-foreground">
        {t('v3.settings.household.yourAccountsHint')}
      </p>
      <ul className="flex flex-col divide-y divide-border">
        {(accounts.data ?? []).map((account) => (
          <li key={account.id} className="flex items-center justify-between gap-2 py-2">
            <label htmlFor={`household-share-${account.id}`} className="text-body">
              {account.name}
            </label>
            <Switch
              id={`household-share-${account.id}`}
              data-account={account.id}
              checked={shared.has(account.id)}
              disabled={busy}
              onCheckedChange={(on) =>
                on
                  ? share.mutate({ accountId: account.id })
                  : unshare.mutate({ accountId: account.id })
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function HouseholdCurrency({ value, onChanged }: { value: string; onChanged: () => void }) {
  const { t } = useTranslation();
  const set = trpc.household.setCurrency.useMutation({
    onSuccess: onChanged,
    onError: (error) => showError(error, t('v3.settings.household.settingCurrency')),
  });
  return (
    <section className="flex flex-col gap-2">
      <label htmlFor="household-currency" className="text-label text-muted-foreground">
        {t('v3.settings.household.currency')}
      </label>
      <p className="text-caption text-muted-foreground">
        {t('v3.settings.household.currencyHint')}
      </p>
      <FiatCurrencyField
        id="household-currency"
        value={value}
        disabled={set.isPending}
        onChange={(tokenId) => {
          if (tokenId && tokenId !== value) set.mutate({ tokenId });
        }}
      />
    </section>
  );
}

function Leave({ name, onLeft }: { name: string; onLeft: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const leave = trpc.household.leave.useMutation({
    onSuccess: () => {
      setOpen(false);
      onLeft();
    },
    onError: (error) => showError(error, t('v3.settings.household.leaving')),
  });
  return (
    <div className="border-t border-border pt-3">
      <ConfirmAction
        label={t('v3.settings.household.leave')}
        triggerClassName="text-destructive hover:text-destructive"
        destructive
        confirmLabel={t('v3.settings.household.leaveConfirm', { name })}
        consequence={t('v3.settings.household.leaveConsequence')}
        open={open}
        onOpenChange={setOpen}
        isPending={leave.isPending}
        onConfirm={() => leave.mutate()}
      />
    </div>
  );
}
