import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resetCloudClientConfig } from '@scani/cloud-client';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { IntegrationCredentialsService } from '@scani/domain/services/users/IntegrationCredentialsService';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { DecryptedCredentials } from '@scani/providers/core/types';
import { BunqProvider } from '@scani/providers/providers/bunq';
import { FioProvider } from '@scani/providers/providers/fio';
import { IbkrProvider } from '@scani/providers/providers/ibkr';
import { InvestecProvider } from '@scani/providers/providers/investec';
import { BullMqEnqueueService } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1729: bunq allows its personal API key only in software the customer runs
// themselves, so the hosted product lists bunq and refuses to connect it. The
// refusal comes before the key is sent to bunq: a key the hosted product must
// not hold is not one it may test either.

restoreContainerAfterAll();

const suffix = randomUUID().slice(0, 8);
let user: typeof schema.users.$inferSelect;
let bunqInstitutionId: string;
const validated: DecryptedCredentials[] = [];
const originalTier = process.env.SCANI_DEPLOYMENT_TIER;

function setTier(tier: string | undefined): void {
  if (tier === undefined) delete process.env.SCANI_DEPLOYMENT_TIER;
  else process.env.SCANI_DEPLOYMENT_TIER = tier;
  resetCloudClientConfig();
}

const connectBunq = () =>
  makeAuthedCaller(user).integrations.validateKeys({
    providerKey: 'bunq',
    credentials: { apiKey: `key-${randomUUID()}` },
    requestId: randomUUID(),
  });

const listed = async (providerKey: string) =>
  (await makeAuthedCaller(user).integrations.listAvailable()).find(
    (entry) => entry.providerKey === providerKey
  );

beforeAll(async () => {
  const registry = new ProviderRegistry();
  // A stand-in for the real provider, whose check calls bunq: this one records
  // what it was asked and answers the way the real one does, with the key's
  // registration added for the connect step to store.
  registry.register({
    providerKey: 'bunq',
    manifest: new BunqProvider({} as never).manifest,
    capabilities: ['credential-validator'],
    async validateCredentials(creds: DecryptedCredentials) {
      validated.push(creds);
      return {
        valid: true,
        credentials: { ...creds, installationToken: 'installation', privateKeyPem: 'pem' },
      };
    },
  });
  registry.register(new IbkrProvider({} as never));
  registry.register(new InvestecProvider({} as never));
  registry.register(new FioProvider({} as never));
  Container.set(ProviderRegistry, registry);
  Container.set(BullMqEnqueueService, {
    async add() {
      return `job-${randomUUID()}`;
    },
  } as unknown as BullMqEnqueueService);

  const [created] = await db
    .insert(schema.users)
    .values({ email: `sc1729-${suffix}@scani.local`, name: 'SC-1729' })
    .returning();
  user = created!;
  const [institution] = await db
    .select()
    .from(schema.institutions)
    .where(eq(schema.institutions.name, 'bunq'));
  if (!institution) throw new Error('the migrations seed bunq');
  bunqInstitutionId = institution.id;
});

afterEach(() => {
  validated.length = 0;
});

afterAll(async () => {
  setTier(originalTier);
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
});

describe.each([
  ['unset', undefined],
  ['3', '3'],
])('on the hosted product (SCANI_DEPLOYMENT_TIER %s)', (_label, tier) => {
  test('bunq is listed as self-hosted only', async () => {
    setTier(tier);
    expect((await listed('bunq'))?.availability).toBe('self-hosted-only');
  });

  // SC-1731: Investec's own credentials serve the customer's own use; a
  // platform for many clients needs Investec's onboarding.
  test('Investec is listed as self-hosted only, and its key cannot move money', async () => {
    setTier(tier);
    const investec = await listed('investec');
    expect(investec?.availability).toBe('self-hosted-only');
    expect(investec?.credentialCanMoveMoney).toBe(false);
    // The connect page reads this to say the key stays on the user's server.
    expect(investec?.selfHostedOnly).toBe(true);
    expect((await listed('ibkr'))?.selfHostedOnly).toBe(false);
  });

  // SC-1732: Fio holds the customer liable for any use of the token by
  // someone else.
  test('Fio banka is listed as self-hosted only, with the CSV statement to upload', async () => {
    setTier(tier);
    const fio = await listed('fio');
    expect(fio?.availability).toBe('self-hosted-only');
    expect(fio?.credentialCanMoveMoney).toBe(false);
    expect(fio?.statementExportFormats).toEqual(['CSV']);
    expect(fio?.credentialNoun).toBe('token');
  });

  test('and carries the statement formats the notice points to', async () => {
    setTier(tier);
    expect((await listed('bunq'))?.statementExportFormats).toEqual(['MT940', 'CSV']);
    expect((await listed('ibkr'))?.statementExportFormats).toEqual([]);
  });

  test('connecting bunq is refused before the key reaches bunq, and nothing is stored', async () => {
    setTier(tier);
    const failure = await connectBunq().catch((err) => err);
    expect(failure?.code).toBe('FORBIDDEN');
    expect(String(failure?.message)).toContain('self-hosted');
    expect(validated).toHaveLength(0);
    const stored = await db
      .select()
      .from(schema.userIntegrationCredentials)
      .where(eq(schema.userIntegrationCredentials.userId, user.id));
    expect(stored).toHaveLength(0);
  });

  test('CONTROL: a provider not marked self-hosted only is available', async () => {
    setTier(tier);
    expect((await listed('ibkr'))?.availability).toBe('available');
  });
});

describe('on a self-hosted install (SCANI_DEPLOYMENT_TIER 1)', () => {
  test('Investec is available', async () => {
    setTier('1');
    expect((await listed('investec'))?.availability).toBe('available');
  });

  test('Fio banka is available', async () => {
    setTier('1');
    expect((await listed('fio'))?.availability).toBe('available');
  });

  test('bunq is available, and the connect stores the registration the check returned', async () => {
    setTier('1');
    expect((await listed('bunq'))?.availability).toBe('available');
    // The form warns that a bunq key can make payments; IBKR's cannot.
    expect((await listed('bunq'))?.credentialCanMoveMoney).toBe(true);
    expect((await listed('ibkr'))?.credentialCanMoveMoney).toBe(false);

    const result = await connectBunq();
    expect(result.success).toBe(true);
    expect(validated).toHaveLength(1);

    const stored = await Container.get(IntegrationCredentialsService).getDecryptedCredentials(
      user.id,
      bunqInstitutionId
    );
    expect(stored?.installationToken).toBe('installation');
    expect(stored?.privateKeyPem).toBe('pem');
    expect(stored?.apiKey).toBe(validated[0]?.apiKey);
  });
});
