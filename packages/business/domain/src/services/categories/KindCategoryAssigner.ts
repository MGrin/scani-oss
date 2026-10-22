import type { DatabaseTransaction } from '@scani/db';
import { STARTER_CATEGORY_NAMES } from '@scani/shared';
import { sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TAKES_A_CATEGORY } from './outside-categories-sql';
import { TransactionCategoryService } from './TransactionCategoryService';

type Names = Readonly<Record<keyof (typeof STARTER_CATEGORY_NAMES)['en'], string>>;
type Key = 'bankFees' | 'interest' | 'dividends' | 'income';
type StarterKey = keyof Names;

/**
 * The starter category a row's type names (operator product call, SC-1720). A
 * dividend is a reward its source marked as one.
 */
const KEY_OF_KIND = sql`case
    when h.kind = 'fee' then 'bankFees'
    when h.kind = 'interest' then 'interest'
    when h.kind = 'reward' and (h.kind_subtype = 'dividend'
      or h.source_metadata ->> 'income' = 'dividend') then 'dividends'
    when h.kind = 'reward' then 'income'
  end`;

/** Where each one sits in the starter set, so a created one lands where a tap would put it. */
const PATH: Record<Key, [parent: keyof Names, child: keyof Names | null]> = {
  bankFees: ['fees', 'bankFees'],
  interest: ['income', 'interest'],
  dividends: ['income', 'dividends'],
  income: ['income', null],
};

const BATCH = 1000;

const namesFor = (language: string | null): Names =>
  STARTER_CATEGORY_NAMES[
    (language?.split('-')[0] ?? 'en') as keyof typeof STARTER_CATEGORY_NAMES
  ] ?? STARTER_CATEGORY_NAMES.en;

/**
 * Categorizes a fee, interest, dividend or reward by its type, where no payee
 * text can (SC-1720). No AI and no call. The category is the person's own of
 * that name, in their language or in English, matched whatever its case. When
 * one of their rows needs it, a person with no categories gets the whole
 * starter set, and a person with some gets only the missing one, in the
 * starter set's place; both in their language (SC-1722).
 *
 * A bank or card row with payee text is left to the learned rules and the AI;
 * a crypto or broker row's counterparty is an address or a venue, not a payee,
 * so its type decides. It writes only rows nobody has categorized or cleared,
 * and marks them `kind`, which the app shows as "Set automatically".
 */
@Service()
export class KindCategoryAssigner {
  private readonly categories = Container.get(TransactionCategoryService);

  /** Every user's rows when `userId` is omitted. Returns how many it wrote. */
  async apply(tx: DatabaseTransaction, userId?: string): Promise<number> {
    const rows = (await tx.execute(sql`select h.id, h.user_id, u.language, ${KEY_OF_KIND} as key
      from holding_transactions h
      join users u on u.id = h.user_id
      join tokens t on t.id = h.token_id
      left join token_types tt on tt.id = t.type_id
      where h.category_id is null and h.category_set_by is null
        and h.kind in ('fee', 'interest', 'reward')
        and ${TAKES_A_CATEGORY}
        and (tt.code is distinct from 'fiat'
          or transaction_payee_key(h.counterparty, h.description) is null)
        ${userId ? sql`and h.user_id = ${userId}` : sql``}`)) as unknown as Array<{
      id: string;
      user_id: string;
      language: string | null;
      key: Key;
    }>;

    const groups = new Map<string, { userId: string; key: Key; names: Names; ids: string[] }>();
    for (const row of rows) {
      const at = `${row.user_id}:${row.key}`;
      const group = groups.get(at) ?? {
        userId: row.user_id,
        key: row.key,
        names: namesFor(row.language),
        ids: [],
      };
      group.ids.push(row.id);
      groups.set(at, group);
    }

    let written = 0;
    const seeded = new Set<string>();
    for (const group of groups.values()) {
      if (!seeded.has(group.userId)) {
        seeded.add(group.userId);
        // A person with no categories gets the whole starter set, as the
        // Categories page's one tap would make it, so they lose nothing when
        // that offer disappears. `suggest` creates nothing for anyone else.
        await this.categories.suggest(group.userId, (key) => group.names[key as StarterKey], tx);
      }
      const categoryId = await this.categoryFor(tx, group.userId, group.key, group.names);
      for (let at = 0; at < group.ids.length; at += BATCH) {
        const ids = group.ids.slice(at, at + BATCH);
        const done = await tx.execute(sql`update holding_transactions
          set category_id = ${categoryId}, category_set_by = 'kind', updated_at = now()
          where category_id is null and category_set_by is null
            and id in (${sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `
            )})
          returning id`);
        written += Array.from(done as unknown as unknown[]).length;
      }
    }
    return written;
  }

  /** The person's category for `key`, in their language first, then English; created if neither exists. */
  private async categoryFor(
    tx: DatabaseTransaction,
    userId: string,
    key: Key,
    names: Names
  ): Promise<string> {
    // Both sides go through Postgres's lower(), so the match does not depend
    // on the database's ctype agreeing with JavaScript about Cyrillic or CJK.
    const own = names[key];
    const english = STARTER_CATEGORY_NAMES.en[key];
    const [found] = (await tx.execute(sql`select id from transaction_categories
      where user_id = ${userId} and lower(name) in (lower(${own}), lower(${english}))
      order by (lower(name) = lower(${own})) desc, parent_id nulls first, id
      limit 1`)) as unknown as Array<{ id: string }>;
    if (found) return found.id;
    const [parent, child] = PATH[key];
    return this.categories.findOrCreatePath(userId, names[parent], child ? names[child] : null, tx);
  }
}
