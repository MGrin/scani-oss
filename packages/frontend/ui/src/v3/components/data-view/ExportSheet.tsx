import { Check, Loader2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../../../lib/cn';
import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerHeader,
} from '../../../ui/bottom-drawer';
import { Button } from '../../../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../../ui/sheet';
import { Switch } from '../../../ui/switch';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import type { CsvSeparator } from '../../lib/export/csv';
import {
  availableExportFormats,
  type ExportFormat,
  exportFormatDetail,
  exportFormatLabel,
  readCsvSeparator,
  readExportFormat,
  readHideAmounts,
  writeCsvSeparator,
  writeExportFormat,
  writeHideAmounts,
} from '../../lib/export/format';

/**
 * The one sheet every export in v3 goes through — a list's, the net-worth
 * history's, the whole account's.
 *
 * It asks three questions and no more: **which set**, **which format**, and —
 * only for CSV, only because getting it wrong is invisible until Excel opens
 * the file as a single column — **which separator**. What it refuses to be is a
 * per-surface dialog: a second export sheet is a second place for "filtered by
 * default" to stop being true.
 *
 * **The default set is the narrowed one.** A reader who filtered a list to
 * twelve rows and then pressed Export did not ask for sixty-nine. The wider set
 * is the second option, named and one tap away, never the default.
 *
 * **The count is on the button.** `Export 12 holdings` is where the choice
 * becomes checkable — someone who meant the whole list sees `12` and changes
 * their mind before the file exists rather than after opening it.
 *
 * **A single option is stated, not offered.** An unfiltered list has one set,
 * and a radio group with one choice is a question with one answer.
 *
 * Two shells, one content, as in `RefineSheet` and `PeekSheet`: bottom drawer
 * below `lg`, right-side panel above it.
 */

const EXPORT_SNAP_POINTS = [0.7, 1] as const;

const SEPARATORS: { value: CsvSeparator; label: string; detail: string }[] = [
  { value: ',', label: 'Comma', detail: 'a,b,c — the usual choice' },
  { value: ';', label: 'Semicolon', detail: 'a;b;c — for a spreadsheet set to a European locale' },
];

function OptionRow({
  label,
  detail,
  active,
  onSelect,
}: {
  label: string;
  detail?: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left',
        'transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        active ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body">{label}</span>
        {detail ? <span className="truncate text-caption">{detail}</span> : null}
      </span>
      {active ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1 py-3">
      <h3 className="px-3 text-caption font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * A boolean row, for the one control here that changes what the file
 * *contains* rather than how it is written.
 *
 * The switch is the control and the text beside it is a description — not a
 * `<label>` wrapping both. That was the first attempt and it was quietly wrong:
 * `Switch` renders a `<button>`, and a `<label>` does not forward a click to a
 * button in any browser, so the "whole row is tappable" it appeared to buy did
 * not exist. Biome's `noLabelWithoutControl` caught the markup; the behaviour
 * was already broken.
 *
 * So the row states what it does and the switch carries the interaction, with
 * `aria-labelledby` tying the two together so the control announces the same
 * words that are printed next to it.
 */
function ToggleRow({
  id,
  label,
  detail,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  detail: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left">
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={`${id}-label`} className="text-body text-foreground">
          {label}
        </span>
        <span id={`${id}-detail`} className="text-caption text-muted-foreground">
          {detail}
        </span>
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-detail`}
        className="shrink-0"
      />
    </div>
  );
}

/** One thing the reader could export. `key` is what comes back on the
 *  request; the caller decides what it means. */
export interface ExportScopeOption {
  key: string;
  label: string;
  detail?: string;
}

export interface ExportRequest {
  scope: string;
  format: ExportFormat;
  separator: CsvSeparator;
  /** SC-93 item 3 — withhold every column that discloses value. */
  hideAmounts: boolean;
}

export interface ExportSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is being exported, lowercase — "holdings", "history". Used in the
   *  sheet's one line of prose and nowhere else. */
  subject: string;
  /** Ordered, first is the default. A single entry renders as a statement
   *  rather than as a choice. */
  scopes: readonly ExportScopeOption[];
  /** The primary button's text, keyed by scope — `Export 12 holdings`. The
   *  caller owns it because only the caller can count what a scope contains. */
  actionLabel: (scope: string) => string;
  /**
   * Whether the chosen scope has nothing to write (SC-116).
   *
   * A function of the scope rather than a flag, because the answer differs
   * between the options: a search matching nothing leaves "These 0 holdings"
   * empty while "All 19 holdings" is fine, and a single disabled button for
   * both would block the way out the sheet is offering.
   */
  disabled?: (scope: string) => boolean;
  /**
   * Which option to start on when the reader has not chosen. Defaults to the
   * first.
   *
   * The net-worth export needs it (SC-97): its options are windows, and the one
   * to start on is **the window on screen**, which is not the first in the list
   * and is not knowable from here.
   */
  defaultScope?: string;
  /**
   * Which formats to offer. Defaults to both.
   *
   * A caller passing one is not narrowing a menu — it is saying the format is
   * not the reader's question here. The whole-account export is the case: its
   * *scopes* are the workbook and the JSON, so a second Format block below them
   * would ask the same question twice and get two answers.
   */
  formats?: readonly ExportFormat[];
  onExport: (request: ExportRequest) => Promise<void>;
}

/** The header. Exported for `RefineHeader`'s reason: the sheet itself is a
 *  Radix portal and renders nothing under `renderToStaticMarkup`. */
export function ExportHeader({ subject }: { subject: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <SheetTitle className="text-title">Export</SheetTitle>
      <SheetDescription className="text-caption">
        {`Download your ${subject} as a file you own.`}
      </SheetDescription>
    </div>
  );
}

export function ExportSections({
  scopes,
  scope,
  onScopeChange,
  formats,
  format,
  onFormatChange,
  separator,
  onSeparatorChange,
  hideAmounts,
  onHideAmountsChange,
}: {
  scopes: readonly ExportScopeOption[];
  scope: string;
  onScopeChange: (scope: string) => void;
  formats: readonly ExportFormat[];
  format: ExportFormat;
  onFormatChange: (format: ExportFormat) => void;
  separator: CsvSeparator;
  onSeparatorChange: (separator: CsvSeparator) => void;
  hideAmounts: boolean;
  onHideAmountsChange: (hide: boolean) => void;
}) {
  const only = scopes.length === 1 ? scopes[0] : null;

  return (
    <>
      <Group title="What to export">
        {only ? (
          <p className="px-3 text-body text-muted-foreground">
            {only.detail ? `${only.label} — ${only.detail}` : only.label}
          </p>
        ) : (
          scopes.map((option) => (
            <OptionRow
              key={option.key}
              label={option.label}
              detail={option.detail}
              active={scope === option.key}
              onSelect={() => onScopeChange(option.key)}
            />
          ))
        )}
      </Group>

      {formats.length > 1 ? (
        <Group title="Format">
          {formats.map((option) => (
            <OptionRow
              key={option}
              label={exportFormatLabel(option)}
              detail={exportFormatDetail(option)}
              active={format === option}
              onSelect={() => onFormatChange(option)}
            />
          ))}
        </Group>
      ) : null}

      {format === 'csv' && formats.includes('csv') ? (
        <Group title="Separator">
          {/* Offered rather than guessed at silently, because getting it wrong
              is invisible until Excel opens the file as a single column. The
              default comes from this browser's own number formatting — see
              `defaultCsvSeparator`. Amounts always use a full stop for the
              decimal, whichever separator is chosen. */}
          {SEPARATORS.map((option) => (
            <OptionRow
              key={option.value}
              label={option.label}
              detail={option.detail}
              active={separator === option.value}
              onSelect={() => onSeparatorChange(option.value)}
            />
          ))}
        </Group>
      ) : null}

      <Group title="Privacy">
        {/* Last, and off by default. It is the only control here that changes
            what the file *contains* rather than how it is written, so it sits
            apart from format and separator — and a reader who never looks at
            this block gets their figures, which is the safe direction to be
            wrong in. */}
        <ToggleRow
          id="export-hide-amounts"
          label="Hide amounts"
          detail="Removes every value, gain/loss and converted column. The file says they were withheld."
          checked={hideAmounts}
          onChange={onHideAmountsChange}
        />
      </Group>
    </>
  );
}

/**
 * The option the sheet opens on when the reader has not chosen one.
 *
 * `defaultScope` wins when it names a real option and is otherwise ignored
 * rather than trusted: the net-worth sheet passes the chart's active range
 * (SC-97), and a range the sheet does not offer must fall back to a live option
 * instead of selecting nothing and disabling the button.
 */
export function initialScope(scopes: readonly ExportScopeOption[], defaultScope?: string): string {
  const preferred = scopes.find((option) => option.key === defaultScope);
  return preferred?.key ?? scopes[0]?.key ?? '';
}

export function ExportSheet({
  open,
  onOpenChange,
  subject,
  scopes,
  actionLabel,
  disabled,
  defaultScope,
  formats = availableExportFormats(),
  onExport,
}: ExportSheetProps) {
  const isDesktop = useIsDesktop();

  const first = initialScope(scopes, defaultScope);
  /**
   * `null` until the reader picks — *not* seeded with the first scope.
   *
   * Seeding it was wrong and shipped wrong: this sheet is mounted with the list
   * rather than on open, so the seed ran while the list was still unfiltered
   * and captured `all`. Applying a filter afterwards changed the options but
   * not the captured value, and `all` was still a valid key, so nothing
   * corrected it — a filtered list exported every row, silently, which is the
   * exact behaviour the ticket exists to prevent. Held as "unchosen", the
   * default is re-derived from the options every render and cannot go stale.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const [remembered, setFormat] = useState<ExportFormat>(readExportFormat);
  // A remembered CSV against a surface that only writes workbooks would send
  // `csv` to a caller with fifteen sheets to place in one table.
  const format = formats.includes(remembered) ? remembered : (formats[0] as ExportFormat);
  const [separator, setSeparator] = useState<CsvSeparator>(readCsvSeparator);
  const [hideAmounts, setHideAmounts] = useState<boolean>(readHideAmounts);
  const [running, setRunning] = useState(false);

  // A scope that no longer exists — the reader cleared the filter while the
  // sheet was open — falls back to the first rather than exporting nothing.
  const scope = chosen && scopes.some((option) => option.key === chosen) ? chosen : first;

  // Closing forgets the choice, so the next open defaults to the narrowed set
  // again. A remembered `all` would quietly outlive the filter it was chosen
  // against.
  useEffect(() => {
    if (!open) setChosen(null);
  }, [open]);

  const chooseFormat = (next: ExportFormat) => {
    setFormat(next);
    writeExportFormat(next);
  };
  const chooseSeparator = (next: CsvSeparator) => {
    setSeparator(next);
    writeCsvSeparator(next);
  };
  const chooseHideAmounts = (next: boolean) => {
    setHideAmounts(next);
    writeHideAmounts(next);
  };

  const run = async () => {
    setRunning(true);
    try {
      await onExport({ scope, format, separator, hideAmounts });
      onOpenChange(false);
    } finally {
      setRunning(false);
    }
  };

  const header = <ExportHeader subject={subject} />;
  const sections = (
    <ExportSections
      scopes={scopes}
      scope={scope}
      onScopeChange={setChosen}
      formats={formats}
      format={format}
      onFormatChange={chooseFormat}
      separator={separator}
      onSeparatorChange={chooseSeparator}
      hideAmounts={hideAmounts}
      onHideAmountsChange={chooseHideAmounts}
    />
  );
  const footer = (
    <div
      className="flex shrink-0 gap-2 border-t border-border px-4 py-3"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>
        Cancel
      </Button>
      <Button className="flex-1" onClick={run} disabled={running || disabled?.(scope) === true}>
        {running ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Preparing…
          </>
        ) : (
          actionLabel(scope)
        )}
      </Button>
    </div>
  );

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md"
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        >
          <div className="shrink-0 border-b border-border px-4 pb-4 pr-12 pt-4">{header}</div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">{sections}</div>
          {footer}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <BottomDrawer open={open} onOpenChange={onOpenChange}>
      <BottomDrawerContent
        snapPoints={EXPORT_SNAP_POINTS}
        expandLabel="Show every option"
        collapseLabel="Show fewer options"
        closeLabel="Close export"
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <BottomDrawerHeader className="border-b border-border pb-3">{header}</BottomDrawerHeader>
        <BottomDrawerBody className="px-1 py-2">{sections}</BottomDrawerBody>
        {footer}
      </BottomDrawerContent>
    </BottomDrawer>
  );
}
