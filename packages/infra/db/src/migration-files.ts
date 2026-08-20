import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A migration's identity is its FILENAME and nothing else — no index, no
 * `when`, no journal entry (SC-335).
 *
 * The thing that kept colliding was a shared scalar: the next four-digit
 * index. Two branches cut from the same commit both read `0049` as the
 * highest, both wrote `0050`, and neither could know about the other until
 * the second one merged. That is not a discipline failure — the correct
 * answer does not exist at authoring time, because it depends on a merge
 * that has not happened yet.
 *
 * So new migrations stop asking for a number. The prefix is a UTC timestamp
 * taken when the file is created:
 *
 *     20260817143012_holding_label.sql
 *
 * Nothing about it is contended. Two agents in two worktrees produce two
 * different names without talking, each adds exactly one file, and the merge
 * is a clean add in either order — which is the property the numbering never
 * had.
 *
 * `0000`–`0050` keep their names forever: they are applied in production and
 * renaming an applied migration is a far worse bug than the one this fixes.
 * A 14-digit prefix sorts after every 4-digit one on the first character, so
 * the two schemes coexist without a special case in the ordering.
 */
export const LEGACY_TAG = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const STAMPED_TAG = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * The legacy space is closed. It is not "0050 is the highest so far" — it is
 * "0050 is the highest there will ever be", which is what makes the contended
 * integer unreachable rather than merely discouraged.
 *
 * It reads 50 and not 49 because 0050 landed on main from another branch while
 * this one sat in review — the contended integer taking one last victim on its
 * way out, and the clearest argument available for closing it. Raising this
 * number is NOT how to add a migration. It is only ever how to admit one that
 * has already run somewhere.
 */
export const HIGHEST_LEGACY_INDEX = 50;

export interface LegacyTag {
  kind: 'legacy';
  index: number;
}

export interface StampedTag {
  kind: 'stamped';
  stamp: string;
  at: Date;
}

export type ParsedTag = LegacyTag | StampedTag;

export interface MigrationFile {
  tag: string;
  file: string;
  sql: string;
  /** sha256 of the file verbatim — the same digest drizzle recorded. */
  sha256: string;
  parsed: ParsedTag;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Formats a Date as the 14-digit UTC prefix. Local time is deliberately not
 * an option: two machines in two zones would order their own files correctly
 * and each other's wrongly.
 */
export function formatStamp(at: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return [
    pad(at.getUTCFullYear(), 4),
    pad(at.getUTCMonth() + 1),
    pad(at.getUTCDate()),
    pad(at.getUTCHours()),
    pad(at.getUTCMinutes()),
    pad(at.getUTCSeconds()),
  ].join('');
}

/**
 * Rejects a stamp that is 14 digits but not a real instant (`...0231...` for
 * February 31st). Round-tripping through `formatStamp` is the check: `Date`
 * silently rolls a bad field over into the next month, and the rolled value
 * no longer prints as what was parsed.
 */
export function parseStamp(stamp: string): Date | null {
  if (!/^\d{14}$/.test(stamp)) return null;
  const at = new Date(
    Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14))
    )
  );
  if (Number.isNaN(at.getTime())) return null;
  return formatStamp(at) === stamp ? at : null;
}

export function parseTag(tag: string): ParsedTag | null {
  const stamped = STAMPED_TAG.exec(tag);
  if (stamped?.[1]) {
    const at = parseStamp(stamped[1]);
    return at ? { kind: 'stamped', stamp: stamped[1], at } : null;
  }
  const legacy = LEGACY_TAG.exec(tag);
  if (legacy?.[1]) return { kind: 'legacy', index: Number(legacy[1]) };
  return null;
}

/**
 * `[a-z0-9_]` only, so the slug can never introduce a character that changes
 * how the filename sorts or how a shell reads it.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

export function newMigrationTag(slug: string, at: Date): string {
  const clean = slugify(slug);
  if (!clean) throw new Error('a migration needs a slug: bun run db:new "<what it does>"');
  const tag = `${formatStamp(at)}_${clean}`;
  if (!STAMPED_TAG.test(tag)) throw new Error(`slug produced an unusable filename: ${tag}`);
  return tag;
}

function describeBadTag(tag: string): string {
  const legacy = LEGACY_TAG.exec(tag);
  if (legacy?.[1] && Number(legacy[1]) > HIGHEST_LEGACY_INDEX) {
    return (
      `${tag}.sql uses a four-digit index. That space closed at ` +
      `${String(HIGHEST_LEGACY_INDEX).padStart(4, '0')} — the next index is exactly what ` +
      'two branches cannot agree on (SC-335). Run `bun run db:new "<what it does>"`.'
    );
  }
  return (
    `${tag}.sql is not a migration name. Expected ` +
    '<14-digit UTC stamp>_<lower_snake_slug>.sql — run `bun run db:new "<what it does>"`.'
  );
}

/**
 * Every `.sql` file in the folder, in apply order, with the digest that
 * decides whether it has already run.
 *
 * The folder IS the manifest. There is no second list to agree with it, so
 * the two silent failures a journal made possible — a file nobody registered,
 * and a registration whose file is gone — have nowhere left to happen.
 */
export function readMigrationFiles(folder: string): MigrationFile[] {
  const names = readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const problems: string[] = [];
  const files: MigrationFile[] = [];

  for (const name of names) {
    const tag = name.slice(0, -'.sql'.length);
    const parsed = parseTag(tag);
    if (!parsed || (parsed.kind === 'legacy' && parsed.index > HIGHEST_LEGACY_INDEX)) {
      problems.push(describeBadTag(tag));
      continue;
    }
    const file = path.join(folder, name);
    const sql = readFileSync(file, 'utf8');
    files.push({ tag, file, sql, sha256: sha256(sql), parsed });
  }

  const stamps = new Map<string, string>();
  for (const file of files) {
    if (file.parsed.kind !== 'stamped') continue;
    const clash = stamps.get(file.parsed.stamp);
    if (clash) problems.push(`${file.tag}.sql and ${clash}.sql share a timestamp prefix`);
    else stamps.set(file.parsed.stamp, file.tag);
  }

  if (problems.length > 0) {
    throw new Error(`migrations folder rejected:\n  - ${problems.join('\n  - ')}`);
  }

  return files;
}
