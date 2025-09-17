import * as React from 'react';
import { cn } from '@/lib/utils';

const TooltipProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return <>{children}</>;
};

interface TooltipContextType {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const TooltipContext = React.createContext<TooltipContextType>({
  open: false,
  setOpen: () => {},
});

const Tooltip: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = React.useState(false);

  return (
    <TooltipContext.Provider value={{ open, setOpen }}>
      <div className="relative">{children}</div>
    </TooltipContext.Provider>
  );
};

const TooltipTrigger: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { open, setOpen } = React.useContext(TooltipContext);

  return (
    <button
      type="button"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          setOpen(!open);
        }
      }}
      className="inline-block"
    >
      {children}
    </button>
  );
};

const TooltipContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { open } = React.useContext(TooltipContext);

    if (!open) return null;

    return (
      <div
        ref={ref}
        className={cn(
          'absolute z-50 bottom-full left-1/2 transform -translate-x-1/2 mb-2 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md',
          className
        )}
        {...props}
      />
    );
  }
);
TooltipContent.displayName = 'TooltipContent';

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
