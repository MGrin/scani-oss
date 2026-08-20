import { afterAll } from 'bun:test';
import { Container } from 'typedi';

// `bun test` runs every file in ONE process and typedi's Container is
// process-global, so a stub left on it by one file is read by every file
// that runs after — and that file resolves a partial stub in place of the
// real @Service(), failing with `x.y is not a function` inside code its
// author never touched. The suite was green only in bun's default file
// order for exactly this reason: 41 of the 72 files that stub the container
// never put it back (SC-448).
//
// The documented remedy was to name each stubbed identifier again in an
// `afterAll`. Over half the files got it wrong, and the ones that did were
// not careless — they forgot ONE identifier out of six, or they stubbed a
// dependency indirectly by constructing a service. A remedy that depends on
// the author enumerating what they touched is the wrong shape. This
// restores whatever the file changed, without being told.

/** typedi's `ServiceMetadata`. Only identity and the field set matter here. */
type Registration = Record<string, unknown> & { id: unknown };

/**
 * typedi 0.10 keeps its registrations in a private array on the default
 * `ContainerInstance`, and reaching it is what makes an exact snapshot
 * possible: the public API can only re-read a binding by CONSTRUCTING it
 * (`Container.get`), which turns a snapshot into a live graph of real
 * services and captures whatever a not-yet-fixed file left behind.
 *
 * `tests/helpers/container.test.ts` fails if this shape ever stops being
 * true, so a typedi upgrade cannot silently turn this helper into a no-op —
 * which would look exactly like the bug it exists to prevent.
 */
export function containerRegistrations(): Registration[] {
  const instance = Container.of('default') as unknown as { services?: Registration[] };
  const services = instance.services;
  if (!Array.isArray(services)) {
    throw new Error(
      'typedi no longer exposes its registrations as `ContainerInstance.services`.\n' +
        'restoreContainerAfterAll() cannot snapshot the container, so container\n' +
        'stubs would leak between test files again. Teach it the new shape.'
    );
  }
  return services;
}

/**
 * Snapshot the container now and restore it when this file's tests finish,
 * so nothing this file stubs is visible to any file that runs after it.
 *
 * Call it once at module scope, above the file's first `Container.set`.
 * Module scope is not a style preference: ESM evaluates a file's imports
 * before its body, so by the time the body runs, every `@Service()` the
 * file imported is already registered and therefore already inside the
 * snapshot. A registration that appears AFTER this point can only have come
 * from the test itself, which is why restoring can drop it.
 *
 * ```ts
 * import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
 *
 * restoreContainerAfterAll();
 *
 * beforeEach(() => {
 *   Container.set(TokenRepository, stub);
 * });
 * ```
 */
export function restoreContainerAfterAll(): void {
  const restore = snapshotContainer();
  openScope(callerFile());
  afterAll(() => {
    restore();
    closeScope();
  });
}

/**
 * The mechanism behind {@link restoreContainerAfterAll}, separated so it can
 * be asserted directly and so a shared test helper that installs a stub of
 * its own can hand a caller the matching undo. A hook that only ever runs
 * after the last assertion in a file cannot be tested through the hook.
 */
export function snapshotContainer(): () => void {
  const saved = containerRegistrations().map((registration) => ({
    registration,
    fields: { ...registration },
  }));
  const known = new Set(saved.map((entry) => entry.registration));

  return () => {
    // Anything registered after the snapshot came from a test — a stub on a
    // Token that had no binding, or on a class the container had never been
    // asked for. Drop those; `Container.remove` is safe here precisely
    // because it cannot reach a pre-existing @Service() registration.
    for (const registration of [...containerRegistrations()]) {
      if (!known.has(registration)) Container.remove(registration.id as never);
    }

    for (const { registration, fields } of saved) {
      // `Container.set` mutates the existing metadata object in place, so
      // restoring its fields restores the binding. `Container.remove`
      // replaces the array instead, so a removed registration has to be put
      // back rather than assigned to.
      Object.assign(registration, fields);
      if (!containerRegistrations().includes(registration)) {
        containerRegistrations().push(registration);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// The guard. `restoreContainerAfterAll()` fixes a file; this makes a file that
// forgot it impossible to miss, so the rule holds without depending on review.
// ---------------------------------------------------------------------------

/**
 * The file whose tests are running, or null between files.
 *
 * bun runs test files strictly one at a time — a file's module body, then its
 * tests, then its `afterAll`s, and only then does the next file load (verified
 * on bun 1.3.14). So "is a restore in scope right now?" is a single flag
 * rather than something that has to be recovered from a stack trace, and a
 * `Container.set` that arrives with no scope open is exactly a stub nobody
 * will put back.
 */
let openFile: string | null = null;
const unguarded = new Map<string, Set<string>>();

function openScope(file: string): void {
  openFile = file;
}

function closeScope(): void {
  openFile = null;
}

/** Where a `Container.set` came from, for the report. */
function callerFile(): string {
  const frames = new Error().stack?.split('\n') ?? [];
  let fallback: string | null = null;
  for (const frame of frames) {
    const path = frame.match(/\(?(\/[^\s()]+\.tsx?):\d+/)?.[1];
    if (!path || path.includes('node_modules') || path.endsWith('/test/helpers/container.ts')) {
      continue;
    }
    if (/\.(test|spec)\.tsx?$/.test(path)) return path.replace(`${process.cwd()}/`, '');
    fallback ??= path.replace(`${process.cwd()}/`, '');
  }
  return fallback ?? '<unknown caller>';
}

/** A readable name for a class, string or `Token` service identifier. */
function identifierName(id: unknown): string {
  if (typeof id === 'function') return id.name || '<anonymous class>';
  return String(id);
}

/**
 * Record every stub installed while no restore is in scope, and fail the run
 * at the end naming the files responsible.
 *
 * Only the two-argument form is watched. `@Service()` registers itself
 * through the one-argument metadata form, so the decorator's own writes are
 * left alone — a guard that flagged those would flag every service in the
 * repo.
 *
 * This catches both ways the rule gets broken: a file that never calls
 * `restoreContainerAfterAll()` (no scope has been opened for it), and a file
 * that writes to the container in an `afterAll` registered after the restore
 * (its scope has already closed). The second is the old hand-written
 * `afterAll(() => Container.set(Dep, new Dep()))` idiom, which is itself a
 * write that outlives the file.
 */
export function installContainerLeakGuard(): void {
  const set = Container.set.bind(Container) as (...args: unknown[]) => typeof Container;

  Container.set = ((...args: unknown[]) => {
    if (args.length >= 2 && openFile === null) {
      const file = callerFile();
      const ids = unguarded.get(file) ?? new Set<string>();
      ids.add(identifierName(args[0]));
      unguarded.set(file, ids);
    }
    return set(...args);
  }) as typeof Container.set;

  afterAll(() => {
    if (unguarded.size === 0) return;

    const report = [...unguarded]
      .map(([file, ids]) => `  ${file}\n      ${[...ids].sort().join(', ')}`)
      .sort()
      .join('\n');

    throw new Error(
      `${unguarded.size} test file(s) stubbed the process-global typedi Container\n` +
        'with nothing in place to put it back:\n' +
        `${report}\n\n` +
        'Every file that runs after one of these resolves the stub instead of the\n' +
        'real @Service(), which is why the suite used to pass only in bun default\n' +
        'file order (SC-448). Fix by calling `restoreContainerAfterAll()` once at\n' +
        "module scope, above the file's first `Container.set`:\n\n" +
        "  import { restoreContainerAfterAll } from '@scani/domain/test-helpers';\n\n" +
        '  restoreContainerAfterAll();\n\n' +
        'If the file already calls it, the write happened after the restore ran —\n' +
        'an `afterAll` registered below it. Delete that hook; the restore covers it.\n'
    );
  });
}
