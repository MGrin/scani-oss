import { cn } from '@/lib/utils';

/**
 * A group's colour is its identity in every list, chart legend and row mark in
 * the app, so it is picked from a fixed set rather than a colour wheel.
 *
 * The swatch keeps one size in both states and marks selection with a ring
 * rather than a border-plus-scale: a control that changes size when chosen
 * reflows the row under the finger that just chose it.
 *
 * `radiogroup`, not ten buttons — this is one choice with ten answers, and a
 * screen reader should say so. The token layer's coarse-pointer rule gives each
 * swatch its 44px hit area without inflating the 20px dot that is drawn.
 */

export const GROUP_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
] as const;

interface GroupColorChoiceProps {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}

export function GroupColorChoice({ value, onChange, disabled }: GroupColorChoiceProps) {
  return (
    <div role="radiogroup" aria-label="Colour" className="flex flex-wrap items-center gap-2">
      {GROUP_COLORS.map((color) => (
        // biome-ignore lint/a11y/useSemanticElements: a native input[type=radio] is excluded from the token layer's coarse-pointer 44px rule (v3-tokens.css keys it off `button`), so swapping it in would silently drop the touch target on the surface this is built for
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={`Colour ${color}`}
          disabled={disabled}
          onClick={() => onChange(color)}
          className={cn(
            'size-5 rounded-full transition-opacity',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'disabled:pointer-events-none disabled:opacity-50',
            value === color
              ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
              : 'opacity-70 hover:opacity-100'
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}
