/**
 * SC-1688. The credential reconciler takes no lock, so two sweeps may pick the
 * same orphaned credential. Its requestId was a fresh `randomUUID()`, which is
 * part of the `exchange-import` jobId, so both sweeps queued an import.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { IntegrationCredentialsService, WalletDiscoveryService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { ReconcilePendingCredentialsProcessor } from '../../src/processors/reconcile-pending-credentials';

restoreContainerAfterAll();

class TestableProcessor extends ReconcilePendingCredentialsProcessor {
  run() {
    return this.handle();
  }
}

let institutionTypeId: string;
let institutionId: string;

beforeAll(async () => {
  const [type] = await db
    .insert(schema.institutionTypes)
    .values({ code: `rpc-${randomUUID().slice(0, 6)}`, name: 'RPC Type' })
    .returning();
  if (!type) throw new Error('institution type insert failed');
  institutionTypeId = type.id;
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `RPC-${randomUUID().slice(0, 6)}`, typeId: type.id })
    .returning();
  if (!inst) throw new Error('institution insert failed');
  institutionId = inst.id;
});

afterAll(async () => {
  await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
});

function wire(importRetryCount: number) {
  const requestIds: string[] = [];
  const orphan = { id: 'cred-1', userId: 'user-1', institutionId, importRetryCount };
  Container.set(IntegrationCredentialsService, {
    findPendingEnqueueOlderThan: async () => [orphan],
    markImportEnqueued: async () => undefined,
    markImportFailed: async () => undefined,
  } as unknown as IntegrationCredentialsService);
  Container.set(WalletDiscoveryService, {
    resolveInstitutionCode: async () => 'kraken',
  } as unknown as WalletDiscoveryService);
  Container.set(BullMqEnqueueService, {
    add: async (_d: unknown, payload: { requestId: string }) => {
      requestIds.push(payload.requestId);
      return `job-${requestIds.length}`;
    },
  } as unknown as BullMqEnqueueService);
  return requestIds;
}

describe('ReconcilePendingCredentialsProcessor (SC-1688)', () => {
  test('two sweeps over the same orphan ask for the same import, so it collapses', async () => {
    const requestIds = wire(0);
    await new TestableProcessor().run();
    await new TestableProcessor().run();
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
  });

  test('CONTROL: a later attempt on the same credential asks for a new import', async () => {
    const first = wire(0);
    await new TestableProcessor().run();
    const second = wire(1);
    await new TestableProcessor().run();
    expect(second[0]).not.toBe(first[0]);
  });
});
