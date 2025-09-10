import { cn } from '@/lib/utils';

interface SkipLinkProps {
  href: string;
  className?: string;
  children: React.ReactNode;
}

export function SkipLink({ href, className, children }: SkipLinkProps) {
  return (
    <a
      href={href}
      className={cn(
        // Position offscreen by default
        'absolute -top-full left-4 z-50',
        // Show when focused
        'focus:top-4 focus:relative',
        // Styling
        'bg-primary text-primary-foreground px-4 py-2 rounded-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'transition-all duration-200',
        className
      )}
    >
      {children}
    </a>
  );
}
