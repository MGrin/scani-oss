interface ScaniLogoProps {
  className?: string;
}

// Mark — square monogram in `currentColor` so it inherits the foreground
// from whatever container it's rendered in. The shape is a simple
// stacked-bar motif suggesting the dashboard's holdings rows; intentionally
// minimalist to read at favicon sizes.
export function ScaniLogo({ className }: ScaniLogoProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M7 15h4" />
      <path d="M7 11h7" />
      <path d="M7 7h10" />
    </svg>
  );
}
