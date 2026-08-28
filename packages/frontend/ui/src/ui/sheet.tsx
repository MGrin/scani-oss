import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import * as React from 'react';
import { useUiTranslation } from '../i18n';
import { cn } from '../lib/cn';
import { type PortalContainer, usePortalContainer } from '../lib/portal-container';

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

const SheetPortal = SheetPrimitive.Portal;

/** Radix's dismissal events are all cancellable; a non-dismissible sheet
 *  cancels them rather than re-implementing the dialog. */
function preventDismissal(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      'fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  // `transition-transform` (instead of `transition`) intentionally narrows
  // the animation to transform-only so `bg-background` applies instantly
  // on mount. With the broad `transition` utility, iOS WebKit (Safari +
  // Brave) was occasionally getting stuck mid-transition on
  // `background-color` when it resolves from `hsl(var(--background))`,
  // leaving the drawer with a transparent background and the page
  // content visible behind it. The slide-in/out itself is driven by the
  // `animate-in` / `animate-out` CSS animations from tailwindcss-animate,
  // so narrowing the transition doesn't affect motion.
  'fixed z-50 gap-4 bg-background p-6 shadow-lg transition-transform ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        // The inline axis is named for reading order, not for the screen
        // (SC-760). `start` is the edge a line of text begins at — physically
        // left in English, right in Arabic — so a nav drawer says `start` once
        // and lands on the correct edge in both. Naming these `left`/`right`
        // and quietly making them logical would leave a label that is false
        // under `dir="rtl"`, which is a worse defect than the one it fixes:
        // the value would be right and every reader of the name wrong.
        //
        // The anchor and the border are logical utilities and need no help.
        // The slide is not: `slide-in-from-*` comes from tailwindcss-animate
        // and sets a physical `--tw-enter-translate-x`, so each side carries
        // an `rtl:` pair. A panel that slides in from the edge it is NOT
        // anchored to reads as a glitch rather than as a mirrored layout.
        //
        // That pair wins by SOURCE ORDER, not by specificity. Tailwind 3.4
        // compiles `rtl:` to `:where([dir="rtl"], [dir="rtl"] *)`, and
        // `:where()` contributes ZERO specificity by definition — so the two
        // rules are both (0,2,0) and the later one in the stylesheet is the
        // one that applies. Tailwind emits `rtl:` after the unprefixed
        // utility. `tests/rtl-css-cascade.test.ts` builds the CSS and pins
        // that order; without it this is an assumption rather than a
        // mechanism, and tailwind-merge does NOT treat the two as conflicting
        // (measured), so nothing upstream of the cascade resolves it either.
        start:
          'inset-y-0 start-0 h-full w-3/4 border-e sm:max-w-sm data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left rtl:data-[state=closed]:slide-out-to-right rtl:data-[state=open]:slide-in-from-right',
        end: 'inset-y-0 end-0 h-full w-3/4 border-s sm:max-w-sm data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right rtl:data-[state=closed]:slide-out-to-left rtl:data-[state=open]:slide-in-from-left',
      },
    },
    defaultVariants: {
      side: 'end',
    },
  }
);

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  /** Where the portal mounts. See `lib/portal-container.tsx`. */
  container?: PortalContainer;
  /**
   * `false` removes every way out the sheet owns — the × in the corner,
   * Escape and a click on the overlay — leaving only whatever the caller puts
   * in the body.
   *
   * Reserved for content the reader cannot get back once the sheet is gone.
   * Escape closes every other sheet in the app, so it is a trained reflex, and
   * a reflex is exactly the wrong thing to let destroy an unrecoverable value
   * (SC-76). `BottomDrawerContent` takes the same prop, so a surface that is
   * a drawer on a phone and a sheet on a desktop says it once per shell and
   * means the same thing in both.
   */
  dismissible?: boolean;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = 'end', className, children, style, container, dismissible = true, ...props }, ref) => {
  const { t } = useUiTranslation();
  const portalContainer = usePortalContainer(container);
  return (
    <SheetPortal container={portalContainer}>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={ref}
        className={cn(sheetVariants({ side }), 'flex flex-col', className)}
        // Inline-style fallback for the drawer background. `bg-background`
        // depends on `--background` cascading through Radix's portal; if
        // the variable is unset for any reason (theme not yet hydrated,
        // some upstream stacking quirk) the class evaluates to `hsl()`,
        // which is invalid → transparent. The fallback in the var()
        // expression resolves to the dark-theme background literal so
        // the drawer is never see-through. Caller `style` still wins.
        style={{ backgroundColor: 'hsl(var(--background, 0 0% 3.9%))', ...style }}
        // Radix closes on Escape and on a press outside the content. A
        // non-dismissible sheet cancels both rather than re-implementing the
        // dialog — see `dismissible`.
        onEscapeKeyDown={dismissible ? undefined : preventDismissal}
        onInteractOutside={dismissible ? undefined : preventDismissal}
        {...props}
      >
        {children}
        {/* Absent rather than disabled when the sheet is not dismissible: a ×
            that is rendered and does nothing reads as a broken app. */}
        {dismissible ? (
          <SheetPrimitive.Close
            className="absolute end-3 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary"
            style={{ top: 'calc(0.875rem + env(safe-area-inset-top, 0px))' }}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">{t('ui.sheet.close')}</span>
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-2 text-center sm:text-start', className)} {...props} />
);
SheetHeader.displayName = 'SheetHeader';

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
SheetFooter.displayName = 'SheetFooter';

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold text-foreground', className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
