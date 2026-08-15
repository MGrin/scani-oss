import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * A segmented control: pick exactly one of 2–4 mutually exclusive options,
 * all of them visible at once.
 *
 * Built on Radix's radio group rather than a toggle group because that is
 * what it is — one value out of a known set. A radio group announces the
 * option count and the current position to a screen reader and gives arrow
 * keys roving focus for free; a toggle group announces N independent
 * pressed/unpressed buttons, which is a different control.
 *
 * **It is full-width on a phone and content-width on a desktop** (SC-71 8.1),
 * and that split is the whole sizing rule — recorded in §8.1 of the v3 design
 * brief, because the two halves pull in opposite directions and the next
 * ticket has to inherit both. On touch every segment is a target, so the
 * control spends the width it has and the token layer floors each segment at
 * 44px (SC-69 1.2). With a pointer nothing is a target: the "Net worth"/"PnL"
 * toggle measured **544×32px per segment** for a nine-character label and the
 * period buttons 215×32px for "1W", while the table under them ran 56px rows —
 * a screen sized backwards for the device reading it. So above `lg` the root
 * stops stretching and the items stop growing, and the control is as wide as
 * what it says.
 */

const Segmented = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root
    ref={ref}
    data-segmented=""
    className={cn(
      // Recessed track, raised thumb — see the note in tabs.tsx on why this
      // uses `bg-card` / `bg-muted` rather than the v3 surface utilities.
      //
      // `data-segmented` is the hook the v3 token layer's hit-area block needs
      // to reach the *item* under a coarse pointer: a `button[role="radio"]` is
      // excluded from the blanket 44px there (a lone radio keeps a small box),
      // but a segment is not a lone radio — it is the whole target. See the
      // "segmented controls" note in v3-tokens.css.
      'inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1 text-muted-foreground',
      // The sizing rule above. `w-full` rather than relying on a flex parent's
      // stretch, so the phone width is the same whatever the control is
      // dropped into; `lg:w-auto` plus `lg:self-start` is what stops a flex or
      // grid parent stretching it back out on a desktop.
      'w-full lg:w-auto lg:self-start',
      className
    )}
    {...props}
  />
));
Segmented.displayName = 'Segmented';

const SegmentedItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-label',
      // Grows to share the phone's width; sizes to its own label on a desktop.
      'flex-1 lg:flex-none',
      'transition-colors duration-fast ease-emphasized',
      'ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:pointer-events-none disabled:opacity-50',
      'data-[state=checked]:bg-muted data-[state=checked]:text-foreground data-[state=checked]:shadow-sm',
      className
    )}
    {...props}
  />
));
SegmentedItem.displayName = 'SegmentedItem';

export { Segmented, SegmentedItem };
