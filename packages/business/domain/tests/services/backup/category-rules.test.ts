import { expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq, sql } from 'drizzle-orm';
import { BackupRestorer } from '../../../src/services/backup/BackupRestorer';
import {
  type BackupRecord,
  BackupWriter,
  backupLine,
} from '../../../src/services/backup/BackupWriter';
import { TransactionCategoryRuleService } from '../../../src/services/categories/TransactionCategoryRuleService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHoldingTransaction } from '../../../test/helpers/factories-extra';

for (const keepRule of [true, false])
  test(`format 3 remaps account/category/owner and preserves custom provenance; rules present=${keepRule}`, async () => {
    await withTestDb(async (tx) => {
      const source = await makeUser(tx);
      const target = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: source.id, institutionId: institution.id });
      const [cat] = await tx.execute(
        sql`insert into transaction_categories(user_id,name) values (${source.id}, 'Food') returning id`
      );
      const categoryId = (cat as { id: string }).id;
      const ledger = await makeHoldingTransaction(tx, {
        userId: source.id,
        accountId: account.id,
        categoryId,
        categorySetBy: 'custom_rule',
      });
      const rules = new TransactionCategoryRuleService();
      if (keepRule)
        await rules.save(
          source.id,
          { accountId: account.id, categoryId, payeeText: 'Cafe Example', enabled: false },
          tx
        );
      const records: BackupRecord[] = [];
      for await (const record of new BackupWriter().records(source.id, tx, 3))
        records.push(JSON.parse(backupLine(record)) as BackupRecord);
      expect(records[0]).toMatchObject({ type: 'header', version: 3 });
      expect(
        records.filter((r) => r.type === 'row' && r.table === 'transaction_category_rule_runs')
      ).toHaveLength(0);
      const open = async function* () {
        yield* records;
      };
      const restored = await new BackupRestorer().restore(target.id, open, tx);
      const saved = await rules.list(target.id, tx);
      expect(saved).toHaveLength(keepRule ? 1 : 0);
      if (keepRule)
        expect(saved[0]).toMatchObject({
          accountId: restored.ids.get(account.id),
          categoryId: restored.ids.get(categoryId),
          enabled: false,
        });
      const [row] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, restored.ids.get(ledger.id) as string));
      expect(row).toMatchObject({
        userId: target.id,
        categoryId: restored.ids.get(categoryId),
        categorySetBy: 'custom_rule',
      });
      expect(await rules.recent(target.id, tx)).toEqual({ items: [] });
    });
  });

for (const version of [1, 2])
  test(`reader still restores format ${version} without saved rules`, async () => {
    await withTestDb(async (tx) => {
      const source = await makeUser(tx);
      const target = await makeUser(tx);
      const records: BackupRecord[] = [];
      for await (const record of new BackupWriter().records(source.id, tx, 3))
        records.push(record.type === 'header' ? { ...record, version } : record);
      const open = async function* () {
        yield* records;
      };
      await new BackupRestorer().restore(target.id, open, tx);
      expect(await new TransactionCategoryRuleService().list(target.id, tx)).toEqual([]);
    });
  });
