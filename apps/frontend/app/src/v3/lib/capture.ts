import { V3_CAPTURE_ROUTES, V3_PAYMENT_ROUTES } from './routes';

/**
 * Every way data gets into Scani, listed by **what the person already has**.
 *
 * v2's Add Data page groups the same six routes under "Portfolio" and
 * "Payments" — which is the shape of the codebase, not of the moment the page
 * is opened in. Nobody stands in front of their phone holding a subsystem.
 * They are holding a screenshot, or a CSV their broker just emailed, or a
 * wallet address, or nothing at all but the figures in their head, and the
 * question the sheet has to answer is which of those it can take.
 *
 * So the groups are Upload / Connect / Type it in, and every title names the
 * thing in the person's hand. "Upload File or Screenshot" becomes two entries
 * pointing at one screen, because a screenshot and a bank statement are two
 * different possessions even where they are one importer.
 *
 * Every row lands on a v3 screen as of V3-44. The `classic: true` flag that
 * marked the four v2 borrowings — and the "Opens the classic screen" line the
 * sheet printed under them — are gone with the borrowings themselves.
 */

type CaptureGroupKey = 'upload' | 'connect' | 'manual';

/**
 * Which of the two things `/import` was opened for.
 *
 * `A screenshot` and `A statement file` are two possessions and one importer,
 * which is the whole reason they are separate rows — and it is also why picking
 * either landed on a page headed "Upload a file", naming neither (SC-71 5.4).
 * The destination reads this and says back what was chosen.
 */
type FileImportKind = 'screenshot' | 'statement';

export const FILE_IMPORT_KIND_PARAM = 'kind';

export interface CaptureRoute {
  id: string;
  group: CaptureGroupKey;
  /** What the person has, in their words. */
  titleKey: string;
  /** One line on what happens to it. Never a second title. */
  descriptionKey: string;
  /** lucide-react icon name, mapped where it is rendered. */
  icon: string;
  path: string;
  /** Accepts `?accountId=` / `?institutionId=` context from the opener. */
  acceptsContext?: boolean;
  /** Set only on the two rows that share `/import` — see `FileImportKind`. */
  kind?: FileImportKind;
}

export interface CaptureGroup {
  key: CaptureGroupKey;
  titleKey: string;
  routes: CaptureRoute[];
}

const ROUTES: readonly CaptureRoute[] = [
  {
    id: 'screenshot',
    group: 'upload',
    titleKey: 'v3.capture.route.screenshot.title',
    descriptionKey: 'v3.capture.route.screenshot.description',
    icon: 'Image',
    path: V3_CAPTURE_ROUTES.fileImport,
    acceptsContext: true,
    kind: 'screenshot',
  },
  {
    id: 'statement',
    group: 'upload',
    titleKey: 'v3.capture.route.statement.title',
    descriptionKey: 'v3.capture.route.statement.description',
    icon: 'FileUp',
    path: V3_CAPTURE_ROUTES.fileImport,
    acceptsContext: true,
    kind: 'statement',
  },
  {
    id: 'invoice',
    group: 'upload',
    titleKey: 'v3.capture.route.invoice.title',
    descriptionKey: 'v3.capture.route.invoice.description',
    icon: 'FileText',
    path: V3_CAPTURE_ROUTES.invoiceUpload,
  },
  {
    id: 'wallet',
    group: 'connect',
    titleKey: 'v3.capture.route.wallet.title',
    descriptionKey: 'v3.capture.route.wallet.description',
    icon: 'Wallet',
    path: V3_CAPTURE_ROUTES.walletImport,
  },
  {
    id: 'exchange',
    group: 'connect',
    titleKey: 'v3.capture.route.exchange.title',
    descriptionKey: 'v3.capture.route.exchange.description',
    icon: 'Plug',
    path: V3_CAPTURE_ROUTES.integrations,
  },
  {
    id: 'manual',
    group: 'manual',
    titleKey: 'v3.capture.route.manual.title',
    descriptionKey: 'v3.capture.route.manual.description',
    icon: 'Keyboard',
    path: V3_CAPTURE_ROUTES.manualEntry,
    acceptsContext: true,
  },
  {
    id: 'movement',
    group: 'manual',
    titleKey: 'v3.capture.route.movement.title',
    descriptionKey: 'v3.capture.route.movement.description',
    icon: 'ArrowLeftRight',
    path: V3_CAPTURE_ROUTES.recordMovement,
  },
  {
    id: 'payment',
    group: 'manual',
    titleKey: 'v3.capture.route.payment.title',
    descriptionKey: 'v3.capture.route.payment.description',
    icon: 'Repeat',
    path: V3_PAYMENT_ROUTES.create,
  },
];

const GROUP_TITLE_KEYS: Record<CaptureGroupKey, string> = {
  upload: 'v3.capture.group.upload',
  connect: 'v3.capture.group.connect',
  manual: 'v3.capture.group.manual',
};

/** Group order is the order of `GROUP_TITLES`; route order inside a group is
 *  the order above. Both are deliberate — a screenshot leads because it is the
 *  thing a phone has most often, and typing leads nothing because it is the
 *  fallback for everything the other five could not take. */
export const CAPTURE_GROUPS: readonly CaptureGroup[] = (
  Object.keys(GROUP_TITLE_KEYS) as CaptureGroupKey[]
).map((key) => ({
  key,
  titleKey: GROUP_TITLE_KEYS[key],
  routes: ROUTES.filter((route) => route.group === key),
}));

export const CAPTURE_ROUTES = ROUTES;

/**
 * The `?accountId=` / `?institutionId=` pair, forwarded to the routes that
 * understand it.
 *
 * v2's Add Data page does the same thing and for the same reason: reaching
 * capture from an account's own screen should not make the user pick that
 * account again on the next screen. Only these two keys cross — forwarding the
 * whole query string would carry a stale `fromExtraction` into an unrelated
 * form.
 */
export function captureContextQuery(params: URLSearchParams): string {
  const forwarded = new URLSearchParams();
  for (const key of ['accountId', 'institutionId']) {
    const value = params.get(key);
    if (value) forwarded.set(key, value);
  }
  const query = forwarded.toString();
  return query ? `?${query}` : '';
}

/**
 * Where a row goes: the path, the forwarded account context, and — for the two
 * rows that share one importer — which of them was picked.
 */
export function captureHref(route: CaptureRoute, contextQuery: string): string {
  const params = new URLSearchParams(route.acceptsContext ? contextQuery : '');
  if (route.kind) params.set(FILE_IMPORT_KIND_PARAM, route.kind);
  const query = params.toString();
  return query ? `${route.path}?${query}` : route.path;
}

interface FileImportCopy {
  titleKey: string;
  descriptionKey: string;
}

const FILE_IMPORT_COPY: Record<FileImportKind, FileImportCopy> = {
  screenshot: {
    titleKey: 'v3.capture.fileImport.screenshot.title',
    descriptionKey: 'v3.capture.fileImport.screenshot.description',
  },
  statement: {
    titleKey: 'v3.capture.fileImport.statement.title',
    descriptionKey: 'v3.capture.fileImport.statement.description',
  },
};

/**
 * What `/import` calls itself, given the row that opened it.
 *
 * The fallback names both, for the reader who reached the page from a bookmark
 * rather than from the sheet — it is one importer, and saying so is honest.
 * What it must never do is name *one* of the two when the reader picked the
 * other.
 */
export function fileImportCopy(kind: string | null): FileImportCopy {
  if (kind === 'screenshot' || kind === 'statement') return FILE_IMPORT_COPY[kind];
  return {
    titleKey: 'v3.capture.fileImport.either.title',
    descriptionKey: 'v3.capture.fileImport.either.description',
  };
}
