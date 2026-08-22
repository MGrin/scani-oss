import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 touch-manipulation active:scale-[0.98]',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        /* These `min-h-[…]` literals are NOT what holds the 44px touch floor
         * up, and reading them as if they were has now produced three wrong
         * conclusions: SC-63 dropped `size="sm"` from three surfaces to escape
         * a floor that was never being defeated, V3-25 assumed a `min-h-*`
         * utility could force 44px onto a desktop control, and SC-472 was
         * filed as "every default Button is 40px, not the 44px it claims".
         *
         * Inside `[data-ui='v3']` — every surface `apps/frontend/app` serves,
         * and via `v3-tokens-root.css` `cloud` and `landing` too — they are
         * inert. `v3-tokens.css` zeroes `min-height`/`min-width` on
         * `[data-ui='v3'] :is(button, …)` and re-spends `var(--tap-target)`
         * behind `@media (pointer: coarse)`. Tailwind's `@layer` directive is
         * not a cascade layer, so both flatten into the same unlayered output
         * and specificity decides — the token layer's selector carries more
         * than one class-level component, a utility carries exactly one.
         *
         * So a mouse gets desktop density and a finger gets the house rule.
         * Measured on the production bundle (2026-08-22, all four sizes, real
         * emitted CSS): inside v3 a coarse pointer gives 44×44 for
         * default/sm/lg/icon alike, and a fine pointer gives 40 / 36 / 44 /
         * 40×40. A 40px default Button under a mouse is the design, not a
         * regression — measuring `min-height` at a desktop viewport reads 0px
         * whether the coarse branch works or not, which is how SC-472 came to
         * be filed against working code.
         *
         * They stay because outside the token layer they are live:
         * `apps/frontend/admin` imports this component and only
         * `styles/globals.css`, so there the literals are the floor.
         *
         * `packages/frontend/ui/tests/styles/tap-target-floor.test.ts` pins
         * the specificity holding this up, including for the `:root` variant;
         * `apps/e2e/tests/a11y/v3-accessibility.spec.ts` measures the rendered
         * box on a phone, which is the only viewport that can see it. */
        default: 'h-10 px-4 py-2 min-h-[44px]',
        sm: 'h-9 rounded-md px-3 min-h-[36px] md:min-h-[36px]', // Keep small on desktop
        lg: 'h-11 rounded-md px-8 min-h-[44px]',
        icon: 'h-10 w-10 min-h-[44px] min-w-[44px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
