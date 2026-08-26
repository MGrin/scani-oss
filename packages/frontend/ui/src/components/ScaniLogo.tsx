import { SCANI_MARK } from '@scani/shared/brand/scani-mark';

interface ScaniLogoProps {
  className?: string;
}

// The Scani mark — a square monogram in `currentColor` so it inherits the
// foreground of whatever container renders it. The shape is a stacked-bar
// motif suggesting the dashboard's holdings rows; intentionally minimalist
// to read at favicon sizes.
//
// The geometry is `SCANI_MARK` in `@scani/shared`, which is also what the PDF
// statement draws (SC-94) — the api cannot import this package, so the numbers
// live somewhere both can reach. The marketing site's favicon still carries
// them by value, because it is a static file with no build step; it is not
// part of this repository, so changing the geometry here means changing that
// copy and regenerating the icon set separately.
export function ScaniLogo({ className }: ScaniLogoProps) {
  const { size, frame, strokeWidth, bars } = SCANI_MARK;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect
        x={frame.inset}
        y={frame.inset}
        width={size - frame.inset * 2}
        height={size - frame.inset * 2}
        rx={frame.radius}
      />
      {bars.map((bar) => (
        <path key={bar.y} d={`M${bar.x1} ${bar.y}h${bar.x2 - bar.x1}`} />
      ))}
    </svg>
  );
}
