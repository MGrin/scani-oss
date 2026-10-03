/** A Postgres SQLSTATE: five digits or upper-case letters (`23505`, `40P01`, `25P02`). */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The fields of a database error this code reads, as postgres.js names them. */
interface DatabaseErrorFields {
  code: string;
  constraint_name?: string;
  constraint?: string;
}

/**
 * The database's own error behind `error`: the first link on its cause chain
 * that carries a SQLSTATE `code`, or null when nothing on it came from the
 * database. The chain is walked because drizzle wraps the driver's error in a
 * `Failed query: ...` of its own, and the fields are on the PostgresError
 * underneath — reading the top-level object alone matches nothing.
 */
export function databaseErrorOf(error: unknown): DatabaseErrorFields | null {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    const { code } = e as { code?: unknown };
    if (typeof code === 'string' && SQLSTATE.test(code)) return e as DatabaseErrorFields;
  }
  return null;
}
