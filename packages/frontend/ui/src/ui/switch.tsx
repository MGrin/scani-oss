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
        'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0'
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
