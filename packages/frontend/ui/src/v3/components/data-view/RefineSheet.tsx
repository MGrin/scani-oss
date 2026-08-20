import { ArrowDown, ArrowUp, Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useUiTranslation } from '../../../i18n';
import { cn } from '../../../lib/cn';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../../ui/accordion';
import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerHeader,
} from '../../../ui/bottom-drawer';
import { Button } from '../../../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../../ui/sheet';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import {
  countLabel,
  filterOptionLabel,
  type V3FilterDef,
  type V3GroupByDef,
  type V3SortDef,
} from '../../lib/data-view';

/**
 * Filter, sort and group, in one bottom sheet.
 *
 * v2 put all three in a toolbar strip above the list — two rows of controls
 * that on a phone became a horizontally-scrolling row of shrunken selects
 * (`DataViewToolbar.tsx:43`). That strip fails twice: it is permanently on
 * screen costing ~88px of a 852px phone to controls that are used seconds a
 * week, and it scrolls sideways, which is the thing v3 does not do.
 *
 * So refinement is a destination, not furniture. One button opens one sheet
 * that owns all three axes; the list gets the vertical space back.
 *
 * Changes apply **live** rather than behind an Apply button — the list is
 * behind the sheet and a phone sheet is dismissible by drag, so a pending
 * state would be a state you can lose by flicking. The result count, in the
 * header where it is above the fold at every height, is the feedback that
 * replaces Apply's confirmation: it says what will be on screen when the sheet
 * closes rather than that something happened. The footer's primary button is
 * therefore named for what it does — `Done` dismisses; it does not apply
 * anything, and V3-39 was filed because `Show 69 holdings` read like it did.
 *
 * Two shells, one content, as in `PeekSheet`. Below `lg` it is `BottomDrawer`;
 * above it a right-side `Sheet`, because a half-height drawer on a 1440px
 * screen is a gesture idiom borrowed onto a pointer. The drawer is not a
 * cosmetic upgrade over `Sheet side="bottom"` — it is what fixes the other two
 * halves of V3-39:
 *
 *   - `SheetContent` draws its own close button at
 *     `top: calc(0.875rem + env(safe-area-inset-top))`, which is right for a
 *     panel whose top edge *is* the top of the screen and wrong for one pinned
 *     to the bottom. In an installed PWA that inset is ~47px, so the `×`
 *     detached from the title and floated into the body — the reported symptom.
 *     `BottomDrawerContent` lays its close out in flow beside the grab handle,
 *     44×44, outside the scrolling region, so there is no offset to be wrong
 *     and nothing for content to slide under.
 *   - A `Sheet` is sized by its content up to `max-h`, so the sections it
 *     cannot fit are simply below the fold with nothing to say so. The drawer
 *     rests at a snap point and hands its body a bounded height, which is what
 *     makes the fold legible rather than silent.
 *
 * Order is `Filter` → `Sort` → `Group`, and that is the fix for the first half
 * of V3-39: filters were last, and at the sheet's rest height on a 390px phone
 * the sort and group blocks alone filled it, so the user reported filtering as
 * missing from a sheet that had it all along. Filtering is why anyone opens
 * this on a 69-row list; sorting is what they do once.
 */

/** Rest heights. The first shows the whole filter block plus the top of `Sort
 *  by` — enough that the fold is visibly a fold — while leaving overlay to tap.
 *  The second is the drag-up destination. */
const REFINE_SNAP_POINTS = [0.6, 1] as const;

function OptionRow({
  label,
  detail,
  active,
  onSelect,
}: {
  label: string;
  detail?: ReactNode;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        // No `min-h-tap`: the sheet opens on desktop too, and the token layer
        // already restores 44px under `pointer: coarse` (see `DataRow.tsx`).
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left',
        'transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        active ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      <span className="min-w-0 flex-1 truncate text-body">{label}</span>
      {detail}
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

interface RefineSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nounKey: string;
  filters: Record<string, string>;
  filterDefs?: V3FilterDef[];
  onSetFilter: (key: string, value: string) => void;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  sortDefs?: V3SortDef[];
  onSetSort: (field: string) => void;
  groupBy: string;
  groupByDefs?: V3GroupByDef[];
  onSetGroupBy: (value: string) => void;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  filteredCount: number;
}

/**
 * Title, live count and the promise about liveness.
 *
 * Exported, like `PeekHeader`, because `RefineSheet` itself renders nothing
 * under `renderToStaticMarkup` — it is a Radix portal — and this is the half
 * that has to be readable at the drawer's rest height.
 */
export function RefineHeader({
  nounKey,
  filteredCount,
}: Pick<RefineSheetProps, 'nounKey' | 'filteredCount'>) {
  const { t } = useUiTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <SheetTitle className="text-title">{t('ui.dataView.refine.title')}</SheetTitle>
      {/* One sentence, both facts, and no contradiction between them: the count
          is what the list will show, and it moves as the controls are touched.
          `aria-live` because that movement is the only confirmation there is,
          and a screen-reader user gets no glance at the number. */}
      <SheetDescription className="text-caption" aria-live="polite">
        {t('ui.dataView.refine.liveCount', {
          counted: countLabel(nounKey, filteredCount),
        })}
      </SheetDescription>
    </div>
  );
}

/**
 * The three axes, in the order they are reached for. Exported for the same
 * reason as `RefineHeader`, and because "filters come first" is a claim a test
 * can check on the markup.
 */
export function RefineSections({
  filters,
  filterDefs,
  onSetFilter,
  sortField,
  sortDirection,
  sortDefs,
  onSetSort,
  groupBy,
  groupByDefs,
  onSetGroupBy,
}: Pick<
  RefineSheetProps,
  | 'filters'
  | 'filterDefs'
  | 'onSetFilter'
  | 'sortField'
  | 'sortDirection'
  | 'sortDefs'
  | 'onSetSort'
  | 'groupBy'
  | 'groupByDefs'
  | 'onSetGroupBy'
>) {
  const { t } = useUiTranslation();
  const activeFilterKeys = Object.entries(filters)
    .filter(([, value]) => value)
    .map(([key]) => key);

  return (
    <>
      {filterDefs && filterDefs.length > 0 && (
        <Group title={t('ui.dataView.refine.filter')}>
          {/* Open exactly the filters that are doing something. A wall of
              expanded option lists is the same failure as the toolbar
              strip, one axis rotated — and collapsed, every axis the list can
              be narrowed by fits above the fold, which is the whole point of
              putting this block first. */}
          <Accordion type="multiple" defaultValue={activeFilterKeys} className="px-3">
            {filterDefs.map((def) => {
              const value = filters[def.key] ?? '';
              const active = def.options.find((o) => o.value === value);
              const activeLabel = active ? filterOptionLabel(active) : undefined;
              return (
                <AccordionItem key={def.key} value={def.key} className="last:border-b-0">
                  <AccordionTrigger>
                    <span className="truncate">{t(def.labelKey)}</span>
                    <span className="ml-auto shrink-0 truncate text-caption text-muted-foreground">
                      {activeLabel ?? t('ui.dataView.refine.any')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="flex flex-col gap-1 pb-3">
                    <OptionRow
                      label={t('ui.dataView.refine.any')}
                      active={!value}
                      onSelect={() => onSetFilter(def.key, '')}
                    />
                    {def.options.map((option) => (
                      <OptionRow
                        key={option.value}
                        label={filterOptionLabel(option)}
                        active={option.value === value}
                        onSelect={() =>
                          onSetFilter(def.key, option.value === value ? '' : option.value)
                        }
                      />
                    ))}
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </Group>
      )}

      {sortDefs && sortDefs.length > 0 && (
        <Group title={t('ui.dataView.refine.sortBy')}>
          {sortDefs.map((def) => (
            <OptionRow
              key={def.key}
              label={t(def.labelKey)}
              active={def.key === sortField}
              // Selecting the active field flips the direction, which is
              // `setSort`'s existing contract — so one control does both
              // and there is no separate direction toggle to find.
              onSelect={() => onSetSort(def.key)}
              detail={
                def.key === sortField ? (
                  <span className="flex shrink-0 items-center gap-1 text-caption">
                    {sortDirection === 'asc' ? (
                      <>
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('ui.dataView.refine.lowToHigh')}
                      </>
                    ) : (
                      <>
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('ui.dataView.refine.highToLow')}
                      </>
                    )}
                  </span>
                ) : undefined
              }
            />
          ))}
        </Group>
      )}

      {groupByDefs && groupByDefs.length > 0 && (
        <Group title={t('ui.dataView.refine.groupBy')}>
          <OptionRow
            label={t('ui.dataView.refine.noGrouping')}
            active={!groupBy}
            onSelect={() => onSetGroupBy('')}
          />
          {groupByDefs.map((def) => (
            <OptionRow
              key={def.key}
              label={t(def.labelKey)}
              active={def.key === groupBy}
              onSelect={() => onSetGroupBy(def.key === groupBy ? '' : def.key)}
            />
          ))}
        </Group>
      )}
    </>
  );
}

/** `Clear all` and the dismiss. Both shells get the bottom inset: on a phone
 *  the home indicator sits over this bar, and on desktop the inset is 0.
 *  Exported for the same reason as `RefineHeader`. */
export function RefineFooter({
  hasActiveFilters,
  onClearFilters,
  onOpenChange,
}: Pick<RefineSheetProps, 'hasActiveFilters' | 'onClearFilters' | 'onOpenChange'>) {
  const { t } = useUiTranslation();
  return (
    <div
      className="flex shrink-0 gap-2 border-t border-border px-4 py-3"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <Button variant="ghost" onClick={onClearFilters} disabled={!hasActiveFilters}>
        {t('ui.dataView.refine.clearAll')}
      </Button>
      <Button className="flex-1" onClick={() => onOpenChange(false)}>
        {t('ui.dataView.refine.done')}
      </Button>
    </div>
  );
}

export function RefineSheet(props: RefineSheetProps) {
  const { open, onOpenChange, nounKey, filteredCount } = props;
  const { t } = useUiTranslation();
  const isDesktop = useIsDesktop();

  const header = <RefineHeader nounKey={nounKey} filteredCount={filteredCount} />;
  const sections = <RefineSections {...props} />;
  const footer = <RefineFooter {...props} />;

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md"
          // Not a class: `SheetContent` sets `backgroundColor` inline as a
          // guard against `--background` being unset behind Radix's portal, and
          // an inline style beats any utility. `--surface-2` is the sheet rung
          // of the ramp (§5.1); `--background` would put the sheet on the page's
          // own surface, with only the overlay to separate them.
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        >
          {/* `pr-12` clears the shell's own close button, which on a side panel
              is correctly placed level with the title. */}
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
        snapPoints={REFINE_SNAP_POINTS}
        expandLabel={t('ui.dataView.refine.expand')}
        collapseLabel={t('ui.dataView.refine.collapse')}
        closeLabel={t('ui.dataView.refine.close')}
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <BottomDrawerHeader className="border-b border-border pb-3">{header}</BottomDrawerHeader>
        {/* `px-1`, not the body default `px-4`: the option rows carry their own
            `px-3` so their hover and focus rings run wider than the text. */}
        <BottomDrawerBody className="px-1 py-2">{sections}</BottomDrawerBody>
        {footer}
      </BottomDrawerContent>
    </BottomDrawer>
  );
}
