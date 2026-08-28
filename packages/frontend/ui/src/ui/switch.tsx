import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as React from 'react';

import { cn } from '../lib/cn';

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      // `min-h-0` is load-bearing: apps/frontend/app ships a global
      // `button { min-height: 44px; min-width: 44px }` in accessibility.css,
      // which otherwise squares the 44×24 track into a 44×44 circle.
      'peer relative inline-flex h-6 min-h-0 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent',
      'transition-colors duration-fast ease-emphasized',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-primary data-[state=unchecked]:border-border data-[state=unchecked]:bg-muted',
      // The track is 24px tall because a taller one reads as a slab rather
      // than a switch. The hit area is grown to the 44px house rule with a
      // pseudo-element instead, so the target clears SC 2.5.8 without the
      // control gaining 20px of visual height.
      'after:absolute after:inset-x-0 after:top-1/2 after:h-[var(--tap-target)] after:-translate-y-1/2 after:content-[""]',
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-sm ring-0',
        'transition-transform duration-fast ease-emphasized',
        // A transform is the one thing `dir` does not flip: `translate-x-5`
        // moves the thumb toward the physical right in both directions. Under
        // RTL the track is mirrored, so the thumb already starts at the right
        // edge and this would push it out of the track rather than across it.
        //
        // The `rtl:` rule wins by SOURCE ORDER, not by specificity. Tailwind
        // 3.4 compiles the variant to `:where([dir="rtl"], [dir="rtl"] *)`,
        // and `:where()` contributes ZERO specificity by definition — so both
        // rules are (0,2,0) and the later one in the stylesheet takes effect.
        // Tailwind emits `rtl:` after the unprefixed utility, which is what
        // makes this work. Pinned by `tests/rtl-css-cascade.test.ts`, because
        // an ordering nobody checks is an assumption, not a mechanism.
        'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
        'rtl:data-[state=checked]:-translate-x-5'
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
