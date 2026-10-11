import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerDescription,
  BottomDrawerHeader,
  BottomDrawerTitle,
  DRAWER_SAFE_BOTTOM,
} from '@scani/ui/ui/bottom-drawer';
import { Button } from '@scani/ui/ui/button';
import { ScrollBody } from '@scani/ui/ui/scroll-body';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@scani/ui/ui/sheet';
import { useIsDesktop } from '@scani/ui/v3/hooks/useMediaQuery';
import {
  ArrowLeft,
  ArrowLeftRight,
  ChevronRight,
  FileText,
  FileUp,
  House,
  Image,
  Import,
  Keyboard,
  type LucideIcon,
  Plug,
  Repeat,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { CAPTURE_GROUPS, captureContextQuery, captureHref } from '../../lib/capture';
import { V3_CAPTURE_ROUTES } from '../../lib/routes';
import { useFitSnapPoints } from '../form/FormSheet';
import { DemoCaptureNote } from './DemoCaptureNote';

const ICONS: Record<string, LucideIcon> = {
  ArrowLeftRight,
  FileText,
  FileUp,
  House,
  Image,
  Import,
  Keyboard,
  Plug,
  Repeat,
  Wallet,
};

/** Full height remains available for connection/manual submenus. */
/** The ceiling; the drawer rests lower when the list is shorter (SC-1433). */
const CAPTURE_REST = 0.85;

const TITLE_KEY = 'v3.capture.sheet.title';
const DESCRIPTION_KEY = 'v3.capture.sheet.subtitle';

const ROW_CLASS = cn(
  'flex w-full items-start gap-3 rounded-md px-3 py-3 text-start',
  'transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
);

interface CaptureRowProps {
  icon: string;
  titleKey: string;
  descriptionKey?: string;
  /** A link out of the sheet, or a step inside it — the row looks the same. */
  to?: string;
  onClick?: () => void;
}

/**
 * `py-3` rather than a tap-target utility: `min-h-tap` is inert on an `<a>`
 * inside v3 (V3-25) and the token layer already supplies 44px under a coarse
 * pointer, so padding is what actually makes the row reachable.
 *
 * `replace`, because the sheet is now a history entry of its own (SC-67) and a
 * push would leave it between the list and the form: Back out of the wallet
 * import would raise the chooser again rather than return to the list.
 * Replacing it also closes the sheet — its `?sheet=` goes with the entry — so
 * there is nothing else for the row to do on the way out.
 */
function CaptureRow({ icon, titleKey, descriptionKey, to, onClick }: CaptureRowProps) {
  const { t } = useTranslation();
  const Icon = ICONS[icon] ?? Keyboard;
  const body = (
    <>
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 text-muted-foreground">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="flex min-h-9 min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="text-label">{t(titleKey)}</span>
        {descriptionKey && (
          <span className="text-caption text-muted-foreground">{t(descriptionKey)}</span>
        )}
      </span>
      <ChevronRight
        className={cn(MIRROR_IN_RTL, 'mt-2 h-4 w-4 shrink-0 text-muted-foreground')}
        aria-hidden="true"
      />
    </>
  );

  return (
    <li>
      {to ? (
        <Link
          to={to}
          replace
          className={ROW_CLASS}
          style={{ transitionDuration: 'var(--motion-fast)' }}
        >
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className={ROW_CLASS}
          style={{ transitionDuration: 'var(--motion-fast)' }}
        >
          {body}
        </button>
      )}
    </li>
  );
}

/**
 * The list on its own, without either frame. Exported because Radix renders
 * nothing at all under `renderToStaticMarkup`, so this is the half of the
 * sheet a test can assert on.
 */
export function CaptureList({ contextQuery }: { contextQuery: string }) {
  const { t } = useTranslation();
  const [group, setGroup] = useState<'connect' | 'manual' | null>(null);
  if (group)
    return (
      <div className="flex flex-col gap-3">
        {/* The in-place back the capture forms use (InstitutionField,
            AccountField): start-aligned, with the arrow. */}
        <Button variant="ghost" className="-ms-2 self-start" onClick={() => setGroup(null)}>
          <ArrowLeft className={cn(MIRROR_IN_RTL, 'me-1 h-4 w-4')} aria-hidden="true" />
          {t('v3.capture.backChoices')}
        </Button>
        <ul>
          {CAPTURE_GROUPS.find((entry) => entry.key === group)?.routes.map((route) => (
            <CaptureRow
              key={route.id}
              icon={route.icon}
              titleKey={route.titleKey}
              descriptionKey={route.descriptionKey}
              to={captureHref(route, contextQuery)}
            />
          ))}
        </ul>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <ul>
        <CaptureRow
          icon="FileUp"
          titleKey="v3.capture.choice.upload"
          to={`${V3_CAPTURE_ROUTES.fileImport}${contextQuery}`}
        />
        <CaptureRow
          icon="Plug"
          titleKey="v3.capture.choice.connect"
          onClick={() => setGroup('connect')}
        />
        <CaptureRow
          icon="Keyboard"
          titleKey="v3.capture.choice.manual"
          onClick={() => setGroup('manual')}
        />
      </ul>
      <p className="px-3 text-caption text-muted-foreground">{t('v3.capture.availabilityNote')}</p>
    </div>
  );
}

interface CaptureSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CaptureSheet({ open, onOpenChange }: CaptureSheetProps) {
  const { t } = useTranslation();
  const isDesktop = useIsDesktop();
  const [searchParams] = useSearchParams();
  // Read off the URL the sheet was opened over, so reaching capture from an
  // account's own screen does not make the user pick that account again.
  const contextQuery = captureContextQuery(searchParams);
  const fit = useFitSnapPoints(open && !isDesktop, CAPTURE_REST);

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="end"
          className="w-full gap-0 p-0 focus:outline-none sm:max-w-md"
          // Focus the panel, not its first option, so nothing reads as already
          // chosen when the sheet opens (SC-1433; FormSheet does the same).
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          // `SheetContent` sets `backgroundColor` inline against an unset
          // `--background`, and an inline style beats any utility.
          // `--surface-2` is the sheet rung of the ramp (§5.1).
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        >
          {/* The shell every other sheet has (rule 3, SC-1433): a fixed header
              over a body that scrolls on its own. It used to scroll whole,
              title and all. */}
          <SheetHeader className="shrink-0 border-b border-border px-4 pt-4 pb-4 pe-12 text-start">
            <SheetTitle className="text-title">{t(TITLE_KEY)}</SheetTitle>
            <SheetDescription className="text-caption">{t(DESCRIPTION_KEY)}</SheetDescription>
            {/* SC-1207. The sheet is where a visitor chooses which write to
                attempt, so it is where the demo has to say what a write does. */}
            <DemoCaptureNote />
          </SheetHeader>
          <ScrollBody className="px-4 py-3">
            <CaptureList contextQuery={contextQuery} />
          </ScrollBody>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <BottomDrawer open={open} onOpenChange={onOpenChange}>
      <BottomDrawerContent
        ref={fit.contentRef}
        snapPoints={fit.snapPoints}
        expandLabel={t('v3.capture.sheet.trigger')}
        collapseLabel={t('v3.capture.sheet.collapse')}
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <BottomDrawerHeader>
          <BottomDrawerTitle>{t(TITLE_KEY)}</BottomDrawerTitle>
          <BottomDrawerDescription>{t(DESCRIPTION_KEY)}</BottomDrawerDescription>
          {/* Identical to the desktop branch: the phone is where the demo is
              most likely to be met from a link, not less. */}
          <DemoCaptureNote />
        </BottomDrawerHeader>
        <BottomDrawerBody className="py-3">
          <div ref={fit.innerRef}>
            <CaptureList contextQuery={contextQuery} />
            {/* The home indicator sits over the last row otherwise. */}
            <div style={{ height: DRAWER_SAFE_BOTTOM }} />
          </div>
        </BottomDrawerBody>
      </BottomDrawerContent>
    </BottomDrawer>
  );
}
